#!/usr/bin/env node
/**
 * 发版收尾核对（2026-11-04）—— 检查**线上 Release 是否真的能装**
 *
 * ## 为什么必须有这一步
 * 2026-11-04 发 0.15.9 时，代码全对、门禁全绿、Release 也建好了，
 * 但我手工发版**忘了跑 scripts/sign-release.js** —— 于是客户端一检查更新就报：
 *   「这个更新包没有通过签名校验，已拒绝下载。请先「检查更新」再下载。」
 *
 * 这是**离线的自检永远抓不到的一类错**：自检只能看代码与本地文件，
 * 看不到「GitHub 上那份正文到底有没有签名块」。所以必须在发完版之后
 * 用真实网络核一遍，且要能自动判断，不能靠人眼扫一眼正文。
 *
 * ## 检查项
 *   1. Release 存在、非 draft、附件存在且字节数与本地一致
 *   2. 正文里的签名块能被内置公钥验过（keyid / version / file / sha256 全对上）
 *   3. 签名块里的 sha256 == 本地安装包的真实 sha256
 *   4. 附件下载 URL 可达（避免「签名对了但资产被删」）
 *
 * 用法：
 *   node scripts/verify-release.js                 # 核对 package.json 里的当前版本
 *   node scripts/verify-release.js 0.15.9          # 核对指定版本
 *   node scripts/verify-release.js --skip-download # 跳过附件可达性探测（离线环境）
 *
 * 退出码：0 全部通过；1 有问题（输出哪一项、为什么）
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const updateSignature = require(path.join(ROOT, "src", "update-signature.js"));

const argv = process.argv.slice(2);
const skipDownload = argv.includes("--skip-download");
const versionArg = argv.find((a) => !a.startsWith("--"));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = versionArg || pkg.version;
const tag = `v${version}`;
const exeName = `MS-Rewards-Auto-Setup-${version}.exe`;
const localExe = path.join(ROOT, "dist", exeName);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** 调 gh 拿 JSON；失败抛错 */
function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  );
}

function main() {
  console.log(`核对 Release ${tag}（安装包 ${exeName}）\n`);

  // ---- 1. Release 与附件 ----
  let rel;
  try {
    rel = ghJson([
      "release", "view", tag,
      "--json", "isDraft,isPrerelease,body,assets,url",
    ]);
  } catch (e) {
    record("Release 存在", false, `gh release view 失败：${String(e.message).split("\n")[0]}`);
    return finish();
  }
  record("Release 存在", true, tag);
  record("不是草稿", rel.isDraft !== true, rel.isDraft ? "仍是 draft，客户端看不到" : "");

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const exeAsset = assets.find((a) => a.name === exeName);
  record("安装包附件存在", !!exeAsset, exeAsset ? `${exeAsset.size} 字节` : `附件里没有 ${exeName}`);

  // ---- 2. 正文签名 ----
  const verdict = updateSignature.verifyReleaseSignature(rel.body || "");
  record(
    "正文签名块验签通过",
    verdict.ok,
    verdict.ok ? `keyid=${verdict.block.keyid.slice(0, 12)}…` : verdict.error
  );

  // ---- 3. 签名内容与本地产物一致 ----
  if (verdict.ok) {
    record("签名 version 与发布版本一致", verdict.block.version === version, `签名里是 ${verdict.block.version}`);
    record("签名 file 与实际附件一致", verdict.block.file === exeName, `签名里是 ${verdict.block.file}`);

    if (fs.existsSync(localExe)) {
      const realSha = crypto
        .createHash("sha256")
        .update(fs.readFileSync(localExe))
        .digest("hex");
      record(
        "签名 sha256 与本地安装包一致",
        verdict.block.sha256 === realSha,
        verdict.block.sha256 === realSha
          ? ""
          : `签名 ${verdict.block.sha256.slice(0, 16)}… vs 本地 ${realSha.slice(0, 16)}…`
      );
      const realSize = fs.statSync(localExe).size;
      record(
        "附件字节数与本地一致",
        exeAsset && exeAsset.size === realSize,
        exeAsset && exeAsset.size === realSize ? "" : `远端 ${exeAsset ? exeAsset.size : "无"} vs 本地 ${realSize}`
      );
    } else {
      record("本地安装包存在（用于比对哈希）", false, `找不到 ${exeName}，无法证明签名指向的是这份包`);
    }
  } else {
    record("签名 version 与发布版本一致", false, "签名块无效，无法继续比对");
  }

  // ---- 4. 附件可达性 ----
  // ⚠️ 别用 `gh api .../assets/<id>` 拉二进制来探测：gh 会把响应读进内存，
  //    100MB 的包必然撞 maxBuffer 或直接失败，反而给出假阴性（0.15.9 实测踩到）。
  //    正确做法是解析出浏览器下载 URL 后发一个 HEAD / 带 Range 的 GET。
  if (!skipDownload && exeAsset) {
    const probe = (url) => {
      try {
        const args = ["-sSIL", "-o", "/dev/null", "-w", "%{http_code}"];
        // 本机 Schannel 在代理 / TLS 拦截环境下无法完成证书吊销检查，会抛
        // CRYPT_E_NO_REVOCATION_CHECK（0.16.0 发版实测），但附件其实 200 可达。
        // 仅 Windows 需要；这里只探测可达性、不验证身份，跳过吊销检查是合理的。
        if (process.platform === "win32") args.push("--ssl-no-revoke");
        args.push(url);
        const out = execFileSync("curl", args, {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
        });
        // ⚠️ 必须真的解析状态码：旧版忽略 stdout，curl 就算拿到 404 也 return true，
        //    「附件可下载」这项等于摆设（0.16.0 发版时发现并修复）。
        // -L 跟随跳转时 %{http_code} 可能输出多次，取最后一次（最终响应）。
        const code = Number(String(out).trim().split(/\s+/).pop());
        return { ok: code >= 200 && code < 400, code };
      } catch {
        return { ok: false, code: 0 };
      }
    };
    // 优先用 asset 的 browser_download_url（gh release view 的 assets 里没有这个字段，
    // 单独查一次）；拿不到就退回 releases/tag/<tag> 页面本身。
    let okProbe = false;
    let detail = "";
    try {
      const detailJson = ghJson(["api", `repos/{owner}/{repo}/releases/tags/${tag}`]);
      const a = (detailJson.assets || []).find((x) => x.name === exeName);
      if (a && a.browser_download_url) {
        const r = probe(a.browser_download_url);
        okProbe = r.ok;
        detail = r.ok ? "" : `HEAD 返回 ${r.code || "请求失败"}（附件可能被删或私有化）`;
      } else {
        const r = probe(detailJson.html_url);
        okProbe = r.ok;
        detail = r.ok ? "" : `Release 页面 HEAD 返回 ${r.code || "请求失败"}`;
      }
    } catch (e) {
      detail = String(e.message || "").split("\n")[0];
    }
    record("附件可下载", okProbe, detail);
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`全部通过（${results.length} 项）—— 这个 Release 客户端能正常安装。`);
    process.exit(0);
  }
  console.log(`有 ${failed.length} 项不通过：`);
  for (const f of failed) console.log(`  · ${f.name}${f.detail ? "：" + f.detail : ""}`);
  if (failed.some((f) => f.name.includes("签名"))) {
    console.log("");
    console.log("修复办法（这就是 0.15.9 当初踩的坑）：");
    console.log("  MSR_UPDATE_SIGN_KEY_FILE=<私钥.pem> node scripts/sign-release.js \\");
    console.log(`    --body release-notes/${version}.md --version ${version} \\`);
    console.log(`    --file ${exeName} --sha256 <本地 exe 的 sha256> --out /tmp/signed.md`);
    console.log(`  gh release edit ${tag} --notes-file /tmp/signed.md`);
  }
  process.exit(1);
}

main();
