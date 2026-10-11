#!/usr/bin/env node
/**
 * 给 Release 正文追加 Ed25519 签名块（CI 用，2026-10-11 供应链）。
 *
 * 用法：
 *   node scripts/sign-release.js --body release-notes-rendered.md --version 0.15.0 \
 *        --file MS-Rewards-Auto-Setup-0.15.0.exe --sha256 <hex> [--out signed.md]
 *
 * 私钥来源（**只认这两种，绝不从源码或仓库里读**）：
 *   ① 环境变量 MSR_UPDATE_SIGN_KEY（PEM 全文，CI Secret 注入）
 *   ② 环境变量 MSR_UPDATE_SIGN_KEY_FILE（指向 PEM 文件的路径）
 *
 * 签名块形如：
 *   <!-- msr-signature
 *   version=0.15.0
 *   file=MS-Rewards-Auto-Setup-0.15.0.exe
 *   sha256=<hex>
 *   keyid=<公钥 SPKI DER 的 sha256 十六进制>
 *   sig=<base64>
 *   -->
 *
 * ⚠️ 用 HTML 注释的原因：GitHub Markdown 会原样保留注释但不渲染出来 ——
 *    人看不到、机器读得到，验签完不影响正文排版。
 */
const fs = require("fs");
const path = require("path");

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

function fail(msg) {
  console.error(`签名失败：${msg}`);
  process.exit(1);
}

const bodyFile = argOf("body");
const version = argOf("version");
const file = argOf("file");
const sha256 = argOf("sha256").toLowerCase();
const outFile = argOf("out");

if (!bodyFile) fail("缺少 --body（渲染后的正文文件）");
if (!version) fail("缺少 --version");
if (!file) fail("缺少 --file（资产文件名）");
if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`--sha256 不是 64 位十六进制：${argOf("sha256")}`);

const pem = process.env.MSR_UPDATE_SIGN_KEY || "";
const pemFile = process.env.MSR_UPDATE_SIGN_KEY_FILE || "";
let privateKeyPem = pem;
if (!privateKeyPem && pemFile) {
  if (!fs.existsSync(pemFile)) fail(`MSR_UPDATE_SIGN_KEY_FILE 指向的文件不存在：${pemFile}`);
  privateKeyPem = fs.readFileSync(pemFile, "utf-8");
}
if (!privateKeyPem) {
  fail(
    "没有私钥。请设置 MSR_UPDATE_SIGN_KEY（PEM 全文）或 MSR_UPDATE_SIGN_KEY_FILE（文件路径）。\n" +
      "  私钥只能放在仓库 Secret 里 —— 提交进版本库等于把签名能力公开。"
  );
}

const sigMod = require(path.join(__dirname, "..", "src", "update-signature.js"));
let keyId;
let signature;
try {
  keyId = sigMod.keyIdOf(privateKeyPem);
  signature = sigMod.sign({ version, file, sha256 }, privateKeyPem);
} catch (e) {
  fail(`签名计算出错（私钥格式不对？）：${e.message}`);
}

const body = fs.readFileSync(bodyFile, "utf-8");
// 已有签名块先删掉，避免重跑时叠两个块
const cleaned = body.replace(/\n*<!-- msr-signature[\s\S]*?-->\n*/g, "\n");
const block =
  `\n<!-- msr-signature\n` +
  `version=${version}\n` +
  `file=${file}\n` +
  `sha256=${sha256}\n` +
  `keyid=${keyId}\n` +
  `sig=${signature}\n` +
  `-->\n`;

const signed = cleaned.replace(/\s*$/, "\n") + block;

// 自测：用内置公钥验一遍。签不出来或验不过就不落盘 ——
// 免得把一个坏签名推到 Release 上，那会让所有客户端直接拒绝更新。
const verdict = sigMod.verifyReleaseSignature(signed);
if (!verdict.ok) fail(`自检不通过（不应该发生，请报 issue）：${verdict.error}`);
const known = sigMod.UPDATE_KEYS.some((k) => k.keyId === keyId);
if (!known) {
  console.error(
    `⚠️ 警告：keyid=${keyId} 不在 src/update-signature.js 的 UPDATE_KEYS 里。\n` +
      `   签名能生成，但**客户端会拒绝它**（fail-closed）。\n` +
      `   要么换成已有的那把私钥，要么把新公钥加进 UPDATE_KEYS 后重新构建。`
  );
  process.exit(2);
}

if (outFile) fs.writeFileSync(outFile, signed, "utf-8");
else process.stdout.write(signed);

console.error(`✅ 已签名 version=${version} file=${file} keyid=${keyId.slice(0, 16)}…`);
