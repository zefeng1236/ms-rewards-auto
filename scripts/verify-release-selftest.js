#!/usr/bin/env node
/**
 * 发版收尾核对的**离线反例自测**（2026-11-06）
 *
 * 为什么需要它：0.16.0 发版时发现「附件可下载」是个假守卫（404 也判通过）。
 * 修完一个假守卫不够 —— 必须证明**每一项**都能被构造反例变红，否则下次
 * 还会出现「代码全绿、Release 其实装不上」的情况。
 *
 * 做法：把 child_process.execFileSync 与 update-signature 换成桩，用本地 dist
 * 里的真实安装包构造一份「全绿」的假 Release，然后逐项注入坏输入跑 main()，
 * 断言对应检查项变成 FAIL。**不联网、不碰线上 Release、不需要私钥**。
 *
 * 用法：node scripts/verify-release-selftest.js
 * 退出码：0 全部反例生效；1 有守卫是摆设（构造了坏输入却没变红）
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const exeName = `MS-Rewards-Auto-Setup-${version}.exe`;
const blockmapName = `${exeName}.blockmap`;
const localExe = path.join(ROOT, "dist", exeName);
const localBm = path.join(ROOT, "dist", blockmapName);

if (!fs.existsSync(localExe)) {
  console.error(`找不到 ${localExe} —— 先 npm run pack 再跑本自测`);
  process.exit(1);
}
const realSha = crypto.createHash("sha256").update(fs.readFileSync(localExe)).digest("hex");
const realSize = fs.statSync(localExe).size;
const realBmSize = fs.existsSync(localBm) ? fs.statSync(localBm).size : 0;

/** 当前用例的可变桩状态；Module._load 的桩每次从这里读 */
let current = null;
const fakeSignature = {
  verifyReleaseSignature: () =>
    current.sigOk
      ? { ok: true, block: current.block }
      : { ok: false, error: "mock：签名块无效" },
};
const fakeExec = (cmd, args) => {
  if (cmd === "gh") {
    if (args[0] === "release" && args[1] === "view") return JSON.stringify(current.rel);
    if (args[0] === "api" && args.some((a) => String(a).includes("releases/latest"))) return current.latest;
    if (args[0] === "api") {
      return JSON.stringify({
        html_url: "https://example.invalid/release",
        assets: current.rel.assets.map((a) => ({
          name: a.name,
          browser_download_url: `https://example.invalid/${a.name}`,
        })),
      });
    }
  }
  if (cmd === "curl") return current.curlOut;
  return "";
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "child_process") return { execFileSync: fakeExec };
  if (/update-signature\.js$/.test(String(request))) return fakeSignature;
  return origLoad.apply(this, arguments);
};
const vr = require(path.join(ROOT, "scripts", "verify-release.js"));
Module._load = origLoad;

const bodyWith = (hash, bytes) =>
  `# ${version}\n\n| 项目 | 值 |\n|---|---|\n` +
  `| 文件名 | \`${exeName}\` |\n` +
  `| 字节数 | ${Number(bytes).toLocaleString("en-US")} |\n` +
  `| SHA256 | \`${hash}\` |\n\n<!-- msr-signature mock -->`;

const base = () => ({
  sigOk: true,
  block: { keyid: "d7ceff76121a", version, file: exeName, sha256: realSha },
  rel: {
    isDraft: false,
    isPrerelease: false,
    body: bodyWith(realSha, realSize),
    url: "https://example.invalid/release",
    assets: [
      { name: exeName, size: realSize },
      { name: blockmapName, size: realBmSize },
    ],
  },
  latest: tag,
  curlOut: "200",
});

/** 跑一次 main()，收集逐项结果；拦截 process.exit 与 console.log */
function run(patch) {
  current = { ...base(), ...(patch || {}) };
  vr.__results.length = 0;
  const lines = [];
  const oldLog = console.log;
  const oldExit = process.exit;
  console.log = (...a) => lines.push(a.join(" "));
  process.exit = () => { throw new Error("__EXIT__"); };
  try {
    vr.main();
  } catch (e) {
    if (!/__EXIT__/.test(String(e && e.message))) throw e;
  } finally {
    console.log = oldLog;
    process.exit = oldExit;
  }
  return { results: vr.__results.map((r) => ({ ...r })), lines };
}

let failed = 0;
function expectOutcome(label, patch, names, want) {
  const { results } = run(patch);
  const missed = names.filter((n) => {
    const r = results.find((x) => x.name === n);
    return !r || r.ok !== want;
  });
  if (missed.length) failed++;
  const word = want === false ? "应红" : "应绿";
  console.log(`${missed.length ? "❌" : "✅"} ${label.padEnd(30)} → ${word}：${names.join("、")}${missed.length ? ` ｜ 不符：${missed.join("、")}` : ""}`);
}
const expectFail = (label, patch, names) => expectOutcome(label, patch, names, false);
const expectPass = (label, patch, names) => expectOutcome(label, patch, names, true);

console.log(`发版收尾核对 · 离线反例自测（${tag}）\n`);

// 基线：所有项都应通过（否则说明桩本身没构造好，后面的反例没有意义）
{
  const { results } = run({});
  const bad = results.filter((r) => r.ok !== true);
  console.log(`${bad.length ? "❌" : "✅"} 基线：${results.length} 项${bad.length ? `（异常：${bad.map((r) => r.name).join("、")}）` : " 全部通过"}`);
  if (bad.length) failed++;
}

const b = base();
expectFail("草稿 Release", { rel: { ...b.rel, isDraft: true } }, ["不是草稿"]);
expectFail("被标为预发布", { rel: { ...b.rel, isPrerelease: true } }, ["不是预发布"]);
expectFail("latest 指向别的版本", { latest: "v0.0.1" }, ["是 Latest（客户端会收到这个版本）"]);
expectFail("漏传 blockmap", { rel: { ...b.rel, assets: [b.rel.assets[0]] } }, ["blockmap 附件存在"]);
expectFail("正文哈希写成旧值", { rel: { ...b.rel, body: bodyWith("0".repeat(64), realSize) } }, ["正文展示的 SHA256 与签名一致"]);
expectFail("正文删掉校验表", { rel: { ...b.rel, body: "# 没有表格" } }, ["正文展示的 SHA256 与签名一致", "正文展示的字节数与本地一致"]);
expectFail("正文字节数写错", { rel: { ...b.rel, body: bodyWith(realSha, realSize + 1) } }, ["正文展示的字节数与本地一致"]);
expectFail("签名 sha256 指向旧包", { block: { ...b.block, sha256: "0".repeat(64) } }, ["签名 sha256 与本地安装包一致", "正文展示的 SHA256 与签名一致"]);
expectFail("远端附件字节数不对", { rel: { ...b.rel, assets: [{ name: exeName, size: realSize + 1 }, b.rel.assets[1]] } }, ["附件字节数与本地一致"]);
expectFail("签名 version 写错", { block: { ...b.block, version: "0.0.1" } }, ["签名 version 与发布版本一致"]);
expectFail("签名 file 写错", { block: { ...b.block, file: "other.exe" } }, ["签名 file 与实际附件一致"]);
expectFail("正文没有签名块", { sigOk: false }, ["正文签名块验签通过", "签名 version 与发布版本一致"]);
expectFail("附件 404", { curlOut: "404" }, ["安装包可下载", "blockmap 可下载"]);
expectFail("重定向没跟完(302)", { curlOut: "302" }, ["安装包可下载", "blockmap 可下载"]);
// 关键：curl -L 的 %{http_code} 可能连写。末尾是 200 说明最终成功，不能误判成失败；
// 末尾是 404 则必须变红。两种都要验证，否则「取末尾三位」可能只是碰巧对。
expectPass("重定向后成功(302200)", { curlOut: "302200" }, ["安装包可下载", "blockmap 可下载"]);
expectFail("重定向后 404(302404)", { curlOut: "302404" }, ["安装包可下载", "blockmap 可下载"]);

console.log("");
if (failed) {
  console.log(`❌ ${failed} 组反例没有生效 —— 说明还有假守卫，必须修`);
  process.exit(1);
}
console.log("✅ 全部反例生效：每一项检查都能被对应的坏输入变红。");
console.log("   注意：这只证明「守卫是真的」，不代替发版后跑 npm run verify:release 核线上。");
