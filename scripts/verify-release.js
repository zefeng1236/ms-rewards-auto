#!/usr/bin/env node
/**
 * 发版收尾核对（2026-11-04 建，2026-11-06 完善）—— 检查**线上 Release 是否真的能装**
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
 * ## 设计原则（2026-11-06 定案）
 * 1. **每一项都必须是真守卫**：能构造反例让它变红。0.16.0 发版时发现旧的
 *    「附件可下载」只 catch curl 异常、不看 HTTP 状态码，404 也判通过 —— 等于摆设。
 * 2. **判定抽成纯函数导出**，可离线做反例断言，不必改动线上 Release 来验证。
 * 3. **`--skip-download` 显式标 SKIP**，不许把「没检查」伪装成「通过」。
 *
 * ## 检查项（15 项）
 *   Release：存在 / 非草稿 / 非预发布 / 是 Latest（客户端实际用的端点）
 *   附件：exe 存在 / blockmap 存在 / 两者都可下载
 *   签名：正文可验签 / version / file / sha256 与本地一致
 *   一致性：附件字节数 / 正文展示的 SHA256 / 正文展示的字节数 三处与真实产物一致
 *
 * 用法：
 *   node scripts/verify-release.js                 # 核对 package.json 里的当前版本
 *   node scripts/verify-release.js 0.15.9          # 核对指定版本
 *   node scripts/verify-release.js --skip-download # 跳过附件可达性探测（离线环境）
 *
 * 退出码：0 无失败项；1 有失败项（输出哪一项、为什么、怎么修）
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
const blockmapName = `${exeName}.blockmap`;
const localExe = path.join(ROOT, "dist", exeName);
const localBlockmap = path.join(ROOT, "dist", blockmapName);

const results = [];
/** ok: true=通过 / false=失败 / null=显式跳过（不计入通过） */
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const mark = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? "  — " + detail : ""}`);
};

/**
 * 纯判定函数 —— 导出供 selfcheck / 反例断言离线驱动。
 * 放这里而不是藏在 main() 里，是为了「每一项都能构造反例」这条原则。
 */
const pure = {
  /** 最终响应只认 2xx；3xx 说明 -L 没跟完重定向链，不能算可下载 */
  isSuccessCode: (code) => Number.isFinite(code) && code >= 200 && code < 300,
  /** -L 时 %{http_code} 可能连写成 "302200"（无分隔符），取末尾三位才是最终响应 */
  parseFinalCode: (out) => {
    const m = String(out || "").trim().match(/(\d{3})\s*$/);
    return m ? Number(m[1]) : 0;
  },
  /** 抓正文「安装包校验」表里展示给用户的 SHA256 */
  extractBodyHash: (body) => {
    const m = String(body || "").match(/\|\s*SHA256\s*\|\s*`([0-9a-f]{64})`/i);
    return m ? m[1].toLowerCase() : null;
  },
  /** 抓正文「安装包校验」表里展示给用户的字节数（带千分位逗号） */
  extractBodyBytes: (body) => {
    const m = String(body || "").match(/\|\s*字节数\s*\|\s*([\d,]+)\s*\|/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  },
};
module.exports = pure;

/** 调 gh 拿 JSON；失败抛错 */
function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  );
}
/** 调 gh 拿纯文本（--jq 输出不是 JSON，不能走 ghJson） */
function ghText(args) {
  return execFileSync("gh", args, {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main() {
  console.log(`核对 Release ${tag}（安装包 ${exeName}）\n`);

  // ---- 1. Release 元数据 ----
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
  // 预发布不会进 releases/latest，客户端的「检查更新」收不到这个版本
  record("不是预发布", rel.isPrerelease !== true, rel.isPrerelease ? "被标为 pre-release，latest 端点不会返回它" : "");

  // 客户端实际请求的端点，直接对标 —— 比只看 isPrerelease 更可靠
  try {
    const latestTag = ghText([
      "api", "repos/{owner}/{repo}/releases/latest", "--jq", ".tag_name",
    ]);
    record(
      "是 Latest（客户端会收到这个版本）",
      latestTag === tag,
      latestTag === tag ? "" : `latest 指向 ${latestTag || "(空)"}，不是 ${tag}`
    );
  } catch (e) {
    record("是 Latest（客户端会收到这个版本）", false, `latest 端点查询失败：${String(e.message).split("\n")[0]}`);
  }

  // ---- 2. 附件（exe 与 blockmap 都是增量更新必需的）----
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const exeAsset = assets.find((a) => a.name === exeName);
  const blockAsset = assets.find((a) => a.name === blockmapName);
  record("安装包附件存在", !!exeAsset, exeAsset ? `${exeAsset.size} 字节` : `附件里没有 ${exeName}`);
  record("blockmap 附件存在", !!blockAsset, blockAsset ? `${blockAsset.size} 字节` : `附件里没有 ${blockmapName}`);

  // ---- 3. 正文签名 ----
  const verdict = updateSignature.verifyReleaseSignature(rel.body || "");
  record(
    "正文签名块验签通过",
    verdict.ok,
    verdict.ok ? `keyid=${verdict.block.keyid.slice(0, 12)}…` : verdict.error
  );

  // ---- 4. 签名 / 本地产物 / 正文展示 三方一致 ----
  if (verdict.ok) {
    record("签名 version 与发布版本一致", verdict.block.version === version, `签名里是 ${verdict.block.version}`);
    record("签名 file 与实际附件一致", verdict.block.file === exeName, `签名里是 ${verdict.block.file}`);

    // ⚠️ 正文那张「安装包校验」表是用户手动核对的依据。历史事故：
    //    exe 被覆盖重传但说明里还写旧哈希 → 用户一校验就失败（2026-10-02 踩过）。
    const shownHash = pure.extractBodyHash(rel.body || "");
    record(
      "正文展示的 SHA256 与签名一致",
      shownHash === verdict.block.sha256,
      shownHash ? `正文 ${shownHash.slice(0, 16)}… / 签名 ${verdict.block.sha256.slice(0, 16)}…` : "正文里没有校验表，用户无从核对"
    );

    if (fs.existsSync(localExe)) {
      const realSha = crypto.createHash("sha256").update(fs.readFileSync(localExe)).digest("hex");
      record(
        "签名 sha256 与本地安装包一致",
        verdict.block.sha256 === realSha,
        verdict.block.sha256 === realSha ? "" : `签名 ${verdict.block.sha256.slice(0, 16)}… vs 本地 ${realSha.slice(0, 16)}…`
      );
      const realSize = fs.statSync(localExe).size;
      record(
        "附件字节数与本地一致",
        exeAsset && exeAsset.size === realSize,
        exeAsset && exeAsset.size === realSize ? "" : `远端 ${exeAsset ? exeAsset.size : "无"} vs 本地 ${realSize}`
      );
      const shownBytes = pure.extractBodyBytes(rel.body || "");
      record(
        "正文展示的字节数与本地一致",
        shownBytes === realSize,
        shownBytes === realSize ? "" : `正文 ${shownBytes ?? "无"} vs 本地 ${realSize}`
      );
      // blockmap 也要和本地产物对得上（漏传 / 传错版本都会让增量更新失效）
      if (fs.existsSync(localBlockmap) && blockAsset) {
        const realBm = fs.statSync(localBlockmap).size;
        record("blockmap 字节数与本地一致", blockAsset.size === realBm,
          blockAsset.size === realBm ? "" : `远端 ${blockAsset.size} vs 本地 ${realBm}`);
      } else {
        record("blockmap 字节数与本地一致", null, "本地或远端缺少 blockmap，跳过比对");
      }
    } else {
      record("本地安装包存在（用于比对哈希）", false, `找不到 ${exeName}，无法证明签名指向的是这份包`);
    }
  } else {
    record("签名 version 与发布版本一致", false, "签名块无效，无法继续比对");
  }

  // ---- 5. 附件可达性 ----
  // ⚠️ 别用 `gh api .../assets/<id>` 拉二进制来探测：gh 会把响应读进内存，
  //    100MB 的包必然撞 maxBuffer 或直接失败，反而给出假阴性（0.15.9 实测踩到）。
  //    正确做法是解析浏览器下载 URL 后发 HEAD。
  const probe = (url) => {
    const args = ["-sSIL", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}"];
    // 本机 Schannel 在代理 / TLS 拦截环境下无法完成证书吊销检查，会抛
    // CRYPT_E_NO_REVOCATION_CHECK（0.16.0 发版实测），但附件其实 200 可达。
    // 仅 Windows 需要；这里只探测可达性、不验证身份，跳过吊销检查是合理的。
    if (process.platform === "win32") args.push("--ssl-no-revoke");
    args.push(url);
    let last = { ok: false, code: 0, err: "" };
    // 代理节点瞬时抖动很常见（0.15.9 推送时踩过 502），失败后重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = execFileSync("curl", args, {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25000,
        });
        const code = pure.parseFinalCode(out);
        last = { ok: pure.isSuccessCode(code), code, err: pure.isSuccessCode(code) ? "" : `HTTP ${code}` };
        if (last.ok) return last;
      } catch (e) {
        // 别把 stderr 吞干净：Schannel / 代理 / DNS 的报错是排查的唯一线索
        const raw = String((e && (e.stderr || e.message)) || "").trim();
        last = { ok: false, code: 0, err: raw.split("\n").pop().slice(0, 110) };
      }
      if (attempt === 0) {
        // 同步等待 800ms（Node 主线程可用；不引额外依赖）
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      }
    }
    return last;
  };

  const probeAsset = (name, present, label) => {
    if (!present) {
      record(label, null, "附件不存在，跳过可达性探测");
      return;
    }
    if (skipDownload) {
      record(label, null, "由 --skip-download 显式跳过（未做可达性检查）");
      return;
    }
    try {
      const detailJson = ghJson(["api", `repos/{owner}/{repo}/releases/tags/${tag}`]);
      const a = (detailJson.assets || []).find((x) => x.name === name);
      if (!a || !a.browser_download_url) {
        record(label, false, "拿不到 browser_download_url");
        return;
      }
      const r = probe(a.browser_download_url);
      record(label, r.ok, r.ok ? "" : r.err || `HTTP ${r.code || "请求失败"}`);
    } catch (e) {
      record(label, false, String((e && e.message) || "").split("\n")[0]);
    }
  };
  probeAsset(exeName, !!exeAsset, "安装包可下载");
  probeAsset(blockmapName, !!blockAsset, "blockmap 可下载");

  finish();
}

function finish() {
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  const passed = results.filter((r) => r.ok === true);
  console.log("");
  if (failed.length === 0) {
    if (skipped.length === 0) {
      console.log(`全部通过（${passed.length} 项）—— 这个 Release 客户端能正常安装。`);
    } else {
      // 有跳过项就不能说「能正常安装」，否则和「假守卫」没区别
      console.log(`无失败项（${passed.length} 通过 / ${skipped.length} 跳过）—— 但跳过项未核验，不能断定客户端能装。`);
      for (const s of skipped) console.log(`  · SKIP ${s.name}：${s.detail}`);
    }
    process.exit(0);
  }
  console.log(`有 ${failed.length} 项不通过：`);
  for (const f of failed) console.log(`  · ${f.name}${f.detail ? "：" + f.detail : ""}`);
  console.log("");
  hintsFor(failed);
  process.exit(1);
}

/** 按失败项给可执行的修复办法，不只对「签名」这一类给提示 */
function hintsFor(failed) {
  const names = failed.map((f) => f.name).join(" ");
  if (/签名/.test(names)) {
    console.log("修复办法（这就是 0.15.9 当初踩的坑）：");
    console.log("  MSR_UPDATE_SIGN_KEY_FILE=<私钥.pem> node scripts/sign-release.js \\");
    console.log(`    --body release-notes/${version}.md --version ${version} \\`);
    console.log(`    --file ${exeName} --sha256 <本地 exe 的 sha256> --out /tmp/signed.md`);
    console.log(`  gh release edit ${tag} --notes-file /tmp/signed.md`);
  }
  if (/正文展示/.test(names)) {
    console.log("正文校验表与产物不一致：改 release-notes/<版本>.md 的字节数/SHA256，");
    console.log(`  重新签名后 gh release edit ${tag} --notes-file <签名后的正文>。`);
  }
  if (/附件|可下载|blockmap/.test(names)) {
    console.log("附件问题：gh release upload <tag> <本地 dist 里的文件> --clobber，");
    console.log("  注意覆盖后要重新签名（签名里的 sha256 必须等于新资产的哈希）。");
  }
  if (/Latest|预发布|草稿/.test(names)) {
    console.log("发布状态问题：确认 Release 已 publish、未勾 pre-release，");
    console.log("  且它是仓库里最新的非预发布版本（客户端读 releases/latest）。");
  }
}

// 测试用途：让 scripts/verify-release-selftest.js 能离线驱动 main() 并逐项读结果，
// 不必为了构造反例去改动线上 Release（那样会短暂影响真实用户）。
pure.ROOT = ROOT;
pure.main = main;
pure.__results = results;
if (require.main === module) main();
