/**
 * 保险库密码学核心（纯 Node，不依赖 Electron）
 *
 * 之所以单独拆一层、且绝不 import electron：
 *   1. 桌面端与将来的 Docker CLI 版共用同一套加密数据格式；
 *   2. Electron 只在「把密钥托管给系统钥匙串」那一层出现（见 keychain.js），
 *      真正在容器里跑时那一层直接降级为不可用，本文件不受影响。
 *
 * 密文格式（base64 编码后整体落盘）：
 *   iv(12B) | authTag(16B) | ciphertext
 * 用 AES-256-GCM：既保密又可校验完整性，密文被篡改会在解密时直接抛错。
 *
 * 密钥结构（三层，改密码不必重加密全部数据）：
 *   用户密码 --scrypt--> 密码密钥(PK) --加密--> 保险库主密钥(VK)
 *   恢复密钥(RK, 随机32B) --加密--> 同一个 VK
 *   VK 才是真正用来加密账户 secrets 的密钥。
 * 这样改密码只需用新 PK 重新加密 VK，无需重写所有账户数据；
 * 忘密码时可用 RK 解出 VK，不必知道原密码。
 */
const crypto = require("crypto");

const VERSION = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * scrypt 参数。
 * N=32768,r=8 约需 128*N*r = 33.5MB 内存，超过 Node 默认 maxmem(32MB)，
 * 因此必须显式抬高 maxmem，否则会抛 "memory limit exceeded"。
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/** 校验串：解密出它即说明密钥正确（不要用空串，避免与「解密失败返回空」混淆） */
const VERIFY_PLAINTEXT = "ms-rewards-vault-ok";

function toB64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
}

function fromB64(s) {
  return Buffer.from(String(s || ""), "base64");
}

/** 生成随机字节（默认 32，用于主密钥 / 恢复密钥 / salt） */
function randomBytes(n = 32) {
  return crypto.randomBytes(n);
}

/**
 * scrypt 派生密钥
 * @param {string} password 明文密码
 * @param {Buffer|string} salt
 * @returns {Buffer} 32 字节密钥
 */
function deriveKey(password, salt, params) {
  const p = params || SCRYPT;
  // maxmem 必须显式带上：持久化到 meta.kdf 后若缺失，这里会退回 Node 默认 32MB，
  // 而 N=32768 需要约 33.5MB，直接抛 memory limit exceeded。
  return crypto.scryptSync(String(password), Buffer.isBuffer(salt) ? salt : fromB64(salt), KEY_LEN, {
    N: p.N || SCRYPT.N,
    r: p.r || SCRYPT.r,
    p: p.p || SCRYPT.p,
    maxmem: p.maxmem || SCRYPT.maxmem,
  });
}

/** AES-256-GCM 加密，返回 base64(iv|tag|ct) */
function encrypt(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return toB64(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

/** AES-256-GCM 解密，密钥错误/密文被改都会抛错 */
function decrypt(key, blob) {
  const raw = fromB64(blob);
  if (raw.length < IV_LEN + TAG_LEN) throw new Error("密文长度不足，格式无效");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 加密一个可 JSON 化的对象 */
function encryptJSON(key, obj) {
  return encrypt(key, JSON.stringify(obj == null ? {} : obj));
}

/** 解密成对象；密钥错误抛错 */
function decryptJSON(key, blob) {
  return JSON.parse(decrypt(key, blob).toString("utf8"));
}

/**
 * 生成保险库元数据
 * @param {string} password 用户密码
 * @param {string} [hint] 可选密码提示（明文存储，仅帮助用户回忆，不参与加密）
 */
function createVault(password, hint) {
  const salt = randomBytes(16);
  const vk = randomBytes(KEY_LEN); // 主密钥：真正加密数据的那把
  const rk = randomBytes(KEY_LEN); // 恢复密钥：忘记密码时的唯一退路
  const pk = deriveKey(password, salt);
  const meta = {
    version: VERSION,
    salt: toB64(salt),
    // maxmem 一并持久化：不同 Node 版本默认值不同，写死才能保证跨环境一致
    kdf: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
    hint: String(hint || ""),
    vkByPw: encrypt(pk, vk), // 主密钥被「密码密钥」加密后的密文
    vkByRk: encrypt(rk, vk), // 主密钥被「恢复密钥」加密后的密文
    verifier: encrypt(vk, VERIFY_PLAINTEXT), // 校验用，判断解锁是否成功
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { meta, vk, recoveryKey: toB64(rk) };
}

/** 用密码解出主密钥；密码错误抛错 */
function vkFromPassword(meta, password) {
  const pk = deriveKey(password, fromB64(meta.salt), meta.kdf);
  return decrypt(pk, meta.vkByPw);
}

/** 用恢复密钥解出主密钥；恢复密钥错误抛错 */
function vkFromRecovery(meta, recoveryKey) {
  // 恢复密钥本身就是 32 字节，直接当 AES-256 密钥用（不再过 KDF）
  const rk = fromB64(recoveryKey);
  if (rk.length !== KEY_LEN) throw new Error("恢复密钥格式不正确");
  return decrypt(rk, meta.vkByRk);
}

/** 校验主密钥是否真的能解密数据（防止「解出一串错误字节」被当成成功） */
function verifyVk(meta, vk) {
  const s = decrypt(vk, meta.verifier).toString("utf8");
  return s === VERIFY_PLAINTEXT;
}

/**
 * 改密码：不动主密钥，只用新密码重新加密一次 VK，
 * 因此所有已加密的账户数据无需重写。
 */
function rewrapPassword(meta, vk, newPassword, newHint) {
  const salt = randomBytes(16);
  const pk = deriveKey(newPassword, salt);
  return {
    ...meta,
    salt: toB64(salt),
    hint: String(newHint == null ? meta.hint : newHint),
    vkByPw: encrypt(pk, vk),
    updatedAt: Date.now(),
  };
}

module.exports = {
  VERSION,
  KEY_LEN,
  SCRYPT,
  toB64,
  fromB64,
  randomBytes,
  deriveKey,
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
  createVault,
  vkFromPassword,
  vkFromRecovery,
  verifyVk,
  rewrapPassword,
};
