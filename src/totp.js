/**
 * TOTP 双因素验证码（RFC 6238）辅助。
 *
 * 用途：授权登录时若账号开了 Authenticator 2FA，检测到验证码输入框后自动填码，
 * 免去用户每轮手动输。密钥由调用方传入，**本模块不读配置、不写磁盘、不落盘**。
 * 纯 Node crypto 实现，不引入新依赖；核心函数可离线打桩测试。
 */
"use strict";

const crypto = require("node:crypto");

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 常见OTP输入框：微软登录页的 otc 输入框 + 通用兜底 */
const TOTP_SELECTORS = [
  'input[name="otc"]',
  'input[name="otcCode"]',
  'input[id*="otc" i]',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"][maxlength="6"]',
];

function normalizeSecret(secret) {
  return String(secret || "").replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

function base32Decode(input) {
  const s = normalizeSecret(input);
  let bits = "";
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`TOTP 密钥含非法字符: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238: HOTP(secret, floor(now / period))，默认 SHA1 / 30s / 6 位 */
function generateTotp(secret, nowMs = Date.now(), opts = {}) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error("TOTP 密钥为空");
  const period = Number(opts.period) > 0 ? Number(opts.period) : DEFAULT_PERIOD;
  const digits = Number(opts.digits) > 0 ? Number(opts.digits) : DEFAULT_DIGITS;
  const algo = String(opts.algorithm || "sha1").toLowerCase().replace("-", "");
  const counter = Math.floor(Number(nowMs) / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** 剩余有效期（秒），供调用方判断是否需要等下一个周期再填 */
function secondsRemaining(nowMs = Date.now(), period = DEFAULT_PERIOD) {
  return period - Math.floor(Number(nowMs) / 1000) % period;
}

/**
 * 在登录页里找 OTP 输入框并填入当前验证码。
 * @param {object} page Playwright Page
 * @param {string} secret TOTP 密钥（调用方提供，不落盘）
 * @returns {Promise<{filled:boolean, selector?:string, reason?:string}>}
 */
async function fillTotpIfNeeded(page, secret, opts = {}) {
  if (!page || page.isClosed?.()) return { filled: false, reason: "页面不可用" };
  const key = normalizeSecret(secret);
  if (!key) return { filled: false, reason: "未配置 TOTP 密钥" };
  let code;
  try { code = generateTotp(key, opts.nowMs); }
  catch (e) { return { filled: false, reason: String(e.message).slice(0, 100) }; }
  // 周期尾端不足 3 秒时等下一轮，避免填进去刚好过期
  if (secondsRemaining(opts.nowMs) < 3) {
    await new Promise((r) => setTimeout(r, 3200));
    code = generateTotp(key);
  }
  for (const sel of (opts.selectors || TOTP_SELECTORS)) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.fill(code);
        if (opts.submitSelector) {
          const submit = page.locator(opts.submitSelector).first();
          if (await submit.count() > 0) await submit.click();
        }
        return { filled: true, selector: sel };
      }
    } catch {}
  }
  return { filled: false, reason: "页面上没有验证码输入框" };
}

module.exports = {
  TOTP_SELECTORS,
  normalizeSecret,
  base32Decode,
  generateTotp,
  secondsRemaining,
  fillTotpIfNeeded,
};
