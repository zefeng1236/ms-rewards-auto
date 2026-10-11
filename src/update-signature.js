/**
 * 更新包签名 —— Ed25519（2026-10-11 安全中心 · 供应链）
 *
 * ## 它补的是什么洞
 * app-update.js 原先的校验（verifyUpdateFile 里有注释）自己就承认了：
 * > GitHub Releases **不提供** asset 的官方 digest，所以这里没有「上游权威哈希」可比对。
 * > 留存 + 重算能抓到的是「文件坏了 / 下了一半 / 被别的程序改过」，
 * > 抓不到「上游当初给的就是坏的」。**这层是防损坏，不是防投毒。**
 *
 * 说得更直接一点：攻击者只要能改 GitHub Release（账号被盗 / token 泄露 /
 * 供应链投毒），就能同时换上**新的 exe** 和**新的 SHA256** —— 两者一起改，
 * 哈希校验立刻失效。这是「自己证明自己」的循环论证。
 *
 * ## 为什么不用 electron-updater / electron-builder 的实现
 * - electron-builder 的 signed update manifest（Ed25519）**在 26.17.0 才引入**，
 *   而 npm 上的正式版还是 26.15.3 —— 拿不到。
 * - 即便拿到了，官方实现只在 **electron-updater** 里生效，
 *   而本项目用的是自研的 app-update.js（652 行，带 gh-proxy 镜像加速链、
 *   Range 断点续传、更新目录「安装目录优先→回落 AppData、绝不提权」这些定制）。
 *   为此推翻自研逻辑换官方库是净损失。
 * 所以自己实现：不动下载链路，只在「决定信任哪个哈希」这一步前面加一道验签。
 *
 * ## 信任模型
 * 公钥**硬编码进源码**（随 exe 打包）→ 攻击者改不了；
 * 私钥只在 CI Secret 里 → 攻击者拿不到签名能力；
 * 攻击者能改 Release 正文，但改不出合法签名 → 验签失败，更新被拒。
 *
 * ⚠️ 与 electron-builder 官方实现的同一个约束（**必须知道**）：
 * 公钥是**这次构建**才进去的，所以**存量已安装的版本依然接受未签名 manifest** ——
 * 签名能力要等「含公钥的版本」发布之后的**再下一个版本**才完全生效。
 * 这不是 bug，是所有「密钥轮换」的固有代价。
 *
 * @see scripts/sign-release.js 发版时怎么签
 */

const crypto = require("crypto");

/**
 * 受信任的公钥列表（PEM）。
 *
 * ⚠️ 数组而非单个：将来轮换密钥时，**新旧两把同时留在列表里**，
 * 老版本用老公钥验签、新版本用新公钥验签，中间不会出现「谁都验不过」的空窗期。
 * 换密钥的正确做法 = 先用新私钥发一版（列表里已有新公钥），再移除旧公钥。
 *
 * keyId = 公钥 SPKI DER 的 SHA-256 十六进制，与 electron-builder 算法一致
 * （将来若切到官方实现也能互相识别）。
 */
const UPDATE_KEYS = [
  {
    keyId: "d7ceff76121aecbc913b395df5bcb2cadd8afcf3eddf11283aeee9f4c9cff771",
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2nXW2swJH0RZf5B0YmAvy4MPJOyMRPi60LkNKI8YJcs=
-----END PUBLIC KEY-----`,
  },
];

const SIG_START = "<!-- msr-signature";
const SIG_END = "-->";

/**
 * 从 Release 正文里抽出签名块。
 *
 * 块里是逐行 `key=value`，形如：
 *   <!-- msr-signature
 *   version=0.15.0
 *   file=MS-Rewards-Auto-Setup-0.15.0.exe
 *   sha256=c5e1c489...
 *   keyid=d7ceff76...
 *   sig=base64
 *   -->
 *
 * 之所以放进 HTML 注释：GitHub Markdown 会原样渲染注释内容但不显示，
 * 人看不到、机器能读到，验签完不影响正文排版。
 *
 * @param {string} body Release 正文
 * @returns {{version:string,file:string,sha256:string,keyid:string,sig:string}|null}
 */
function parseSignatureBlock(body) {
  const text = String(body || "");
  const start = text.indexOf(SIG_START);
  if (start < 0) return null;
  const end = text.indexOf(SIG_END, start);
  if (end < 0) return null;
  const inner = text.slice(start + SIG_START.length, end);
  const out = {};
  for (const line of inner.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
  }
  if (!out.sig || !out.sha256) return null;
  return out;
}

/**
 * 剥掉正文里的签名块 —— **交给界面的正文不该带机器读的注释**。
 *
 * GitHub 渲染 Markdown 时 HTML 注释不显示；但更新弹窗/更新日志的
 * markdown-lite 渲染器不隐藏注释，不剥的话更新日志末尾会整段露出
 * `<!-- msr-signature … -->`（2026-10-11 用户实测：0.15.0 检查更新、
 * 读的是最新版 0.15.1 的正文，签名块被原样显示出来）。
 *
 * ⚠️ 只用于「展示副本」。验签必须用**原始正文** —— 先剥再验会把块本身删掉，
 *    验签必然失败，等于把所有更新都拒掉。
 *
 * @param {string} text Release 正文
 * @returns {string} 剥掉签名块（含其周围空行）的正文；无签名块时原样返回
 */
function stripSignatureBlock(text) {
  const s = String(text || "");
  if (!s.includes(SIG_START)) return s;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s
    .replace(new RegExp(`\\n*${esc(SIG_START)}[\\s\\S]*?${esc(SIG_END)}\\n*`, "g"), "\n")
    .replace(/\s+$/, "");
}

/**
 * 构造被签名的字节串。
 *
 * ⚠️ 字段顺序必须**固定且两端一致**，否则签名永远对不上。
 * 用 `|` 分隔且字段本身不允许出现 `|`（版本号/文件名/十六进制哈希都不含）。
 */
function signingPayload({ version, file, sha256 }) {
  return Buffer.from(`${version}|${file}|${sha256}`, "utf-8");
}

/**
 * 验证 Release 正文的签名。
 *
 * ⚠️ **fail-closed**：没签名 / 签名坏 / keyid 不认识，一律判失败。
 *    这是整套机制的立足点 —— 只要有「验不过就跳过验签」的后门，
 *    攻击者只要把签名删掉就能降级到未签名路径，签名就白做了。
 *
 * @param {string} body Release 正文
 * @returns {{ok: true, block: object}|{ok: false, error: string}}
 */
function verifyReleaseSignature(body) {
  const block = parseSignatureBlock(body);
  if (!block) {
    return { ok: false, error: "发布说明里没有签名块（不是我们发的版本？）" };
  }
  const key = UPDATE_KEYS.find((k) => k.keyId === block.keyid);
  if (!key) {
    return { ok: false, error: `签名用的密钥不认识（keyid=${block.keyid || "空"}）` };
  }
  let pub;
  try {
    pub = crypto.createPublicKey(key.pem);
  } catch (e) {
    return { ok: false, error: `内置公钥无法解析：${e.message}` };
  }
  let sig;
  try {
    sig = Buffer.from(block.sig, "base64");
  } catch {
    return { ok: false, error: "签名不是合法的 base64" };
  }
  const payload = signingPayload(block);
  const valid = sig.length === 64 && crypto.verify(null, payload, pub, sig);
  if (!valid) {
    return { ok: false, error: "**签名校验不通过** —— 这个更新包的来源不可信，已拒绝安装" };
  }
  return { ok: true, block };
}

/** 给 CI 用的签名入口（私钥从环境变量或文件读，绝不从源码来） */
function sign(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(String(privateKeyPem));
  return crypto.sign(null, signingPayload(payload), key).toString("base64");
}

/** keyId 由私钥推导（给 CI 打印用，避免手抄错） */
function keyIdOf(privateKeyPem) {
  const key = crypto.createPrivateKey(String(privateKeyPem));
  const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("hex");
}

module.exports = {
  UPDATE_KEYS,
  SIG_START,
  SIG_END,
  parseSignatureBlock,
  stripSignatureBlock,
  signingPayload,
  verifyReleaseSignature,
  sign,
  keyIdOf,
};
