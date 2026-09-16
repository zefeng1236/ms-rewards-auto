/**
 * 保险库编排层：可插拔解锁源 + 加解密入口
 *
 * 解锁源按优先级尝试，哪条通了用哪条（这是跨平台的关键）：
 *   1. 系统钥匙串   —— 桌面端日常免密（Windows DPAPI / macOS Keychain）
 *   2. 环境变量     —— 无桌面环境（Docker）用 MS_REWARDS_VAULT_PASSWORD
 *                      或 MS_REWARDS_VAULT_KEY 在启动时注入
 *   3. 交互输入密码 —— GUI 弹窗 / CLI 读取，前两条都不通时的兜底
 *
 * 未配置保险库时（vault.json 不存在），加密功能整体关闭，
 * 保持与旧版本一致的明文存储行为，不会把老用户挡在门外。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("./crypto");
const keychain = require("./keychain");
const sp = require("../storage-path");
const logger = require("../logger");

const VAULT_FILE = sp.resolve("vault.json");
const KEY_FILE = sp.resolve(".vaultkey");

/** Docker/无桌面场景的解锁环境变量 */
const ENV_PASSWORD = "MS_REWARDS_VAULT_PASSWORD";
const ENV_KEY = "MS_REWARDS_VAULT_KEY";

/** 内存中的主密钥；进程结束即消失，绝不落盘明文 */
let vk = null;
/** 本次是否由环境变量解锁（界面上要提示用户） */
let unlockedByEnv = false;

function readMeta() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return null;
    return JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
  } catch (e) {
    logger.error(`读取保险库配置失败: ${e.message}`);
    return null;
  }
}

function writeMeta(meta) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

/** 是否已配置保险库（决定账户数据是否加密存储） */
function isConfigured() {
  return !!readMeta();
}

/** 是否可加解密（已配置且已解锁） */
function isReady() {
  return !!vk;
}

function isUnlocked() {
  return !!vk;
}

/** 解锁成功后：缓存主密钥，并托管给系统钥匙串实现下次免密 */
function adoptVk(nextVk) {
  vk = nextVk;
  if (keychain.isAvailable()) {
    keychain.saveKey(KEY_FILE, crypto.toB64(nextVk));
  }
  return true;
}

/**
 * 首次设置：用密码建库
 * @returns {{ok:boolean, recoveryKey?:string, error?:string}}
 */
function setup(password, hint) {
  if (isConfigured()) return { ok: false, error: "保险库已配置，请勿重复设置" };
  if (!password || String(password).length < 6) {
    return { ok: false, error: "密码至少 6 位" };
  }
  try {
    const { meta, vk: nextVk, recoveryKey } = crypto.createVault(password, hint);
    writeMeta(meta);
    adoptVk(nextVk);
    logger.ok("保险库已创建，账户登录态将以密文存储");
    return { ok: true, recoveryKey };
  } catch (e) {
    logger.error(`创建保险库失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 用密码解锁 */
function unlock(password) {
  const meta = readMeta();
  if (!meta) return { ok: false, error: "尚未配置保险库" };
  try {
    const nextVk = crypto.vkFromPassword(meta, password);
    if (!crypto.verifyVk(meta, nextVk)) throw new Error("校验失败");
    adoptVk(nextVk);
    unlockedByEnv = false;
    logger.ok("保险库已解锁");
    return { ok: true };
  } catch {
    logger.warn("解锁失败：密码错误");
    return { ok: false, error: "密码错误，请重试" };
  }
}

/** 用恢复密钥解锁（忘记密码时使用，无需原密码） */
function unlockWithRecovery(recoveryKey) {
  const meta = readMeta();
  if (!meta) return { ok: false, error: "尚未配置保险库" };
  try {
    const nextVk = crypto.vkFromRecovery(meta, recoveryKey);
    if (!crypto.verifyVk(meta, nextVk)) throw new Error("校验失败");
    adoptVk(nextVk);
    unlockedByEnv = false;
    logger.ok("已使用恢复密钥解锁保险库");
    return { ok: true };
  } catch {
    return { ok: false, error: "恢复密钥不正确" };
  }
}

/** 尝试系统钥匙串免密解锁 */
function tryKeychainUnlock() {
  if (!isConfigured()) return false;
  if (!keychain.isAvailable()) return false;
  const s = keychain.loadKey(KEY_FILE);
  if (!s) return false;
  const meta = readMeta();
  if (!meta) return false;
  try {
    const nextVk = crypto.fromB64(s);
    if (!crypto.verifyVk(meta, nextVk)) return false;
    vk = nextVk;
    logger.info("已通过系统钥匙串自动解锁保险库");
    return true;
  } catch {
    return false;
  }
}

/** 尝试环境变量解锁（Docker / 无桌面场景） */
function tryEnvUnlock() {
  if (!isConfigured()) return false;
  const pw = process.env[ENV_PASSWORD];
  const rk = process.env[ENV_KEY];
  if (!pw && !rk) return false;
  const r = pw ? unlock(pw) : unlockWithRecovery(rk);
  if (r.ok) {
    unlockedByEnv = true;
    logger.info(`已通过环境变量 ${pw ? ENV_PASSWORD : ENV_KEY} 解锁保险库`);
    return true;
  }
  logger.warn(`环境变量解锁失败：${r.error}`);
  return false;
}

/**
 * 启动时自动解锁：钥匙串优先，其次环境变量。
 * 都不通则返回 false，由界面弹窗要密码。
 */
function tryAutoUnlock() {
  if (!isConfigured()) return false;
  if (tryKeychainUnlock()) return true;
  if (tryEnvUnlock()) return true;
  logger.info("保险库未解锁，等待用户输入密码");
  return false;
}

/** 锁定：丢弃内存主密钥与系统托管 */
function lock() {
  vk = null;
  unlockedByEnv = false;
  keychain.clearKey(KEY_FILE);
  logger.info("保险库已锁定");
  return true;
}

/** 修改密码：只重加密主密钥，已加密的账户数据无需重写 */
function changePassword(current, next, hint) {
  const meta = readMeta();
  if (!meta) return { ok: false, error: "尚未配置保险库" };
  if (!isUnlocked()) return { ok: false, error: "保险库处于锁定状态" };
  if (!next || String(next).length < 6) return { ok: false, error: "新密码至少 6 位" };
  // 改密前必须验证当前密码，防止别人趁会话未锁定时改掉
  try {
    const check = crypto.vkFromPassword(meta, current);
    if (!crypto.verifyVk(meta, check)) throw new Error("校验失败");
  } catch {
    return { ok: false, error: "当前密码不正确" };
  }
  try {
    const nextMeta = crypto.rewrapPassword(meta, vk, next, hint);
    writeMeta(nextMeta);
    // 旧钥匙串里存的还是同一个 VK，依然有效，无需重写
    logger.ok("保险库密码已更新");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 忘记密码时用恢复密钥重置密码。
 *
 * 与 changePassword 的区别：这里不需要原密码，而是用恢复密钥解出主密钥
 * （与「用恢复密钥解锁」同一套校验），再用新密码重新包裹同一把主密钥 ——
 * 因此已加密的账户数据无需重写，旧恢复密钥依然有效（主密钥没变）。
 *
 * @returns {{ok:boolean, error?:string}}
 */
function resetPasswordWithRecovery(recoveryKey, next, hint) {
  const meta = readMeta();
  if (!meta) return { ok: false, error: "尚未配置保险库" };
  const key = String(recoveryKey == null ? "" : recoveryKey).trim();
  if (!key) return { ok: false, error: "请输入恢复密钥" };
  if (!next || String(next).length < 6) return { ok: false, error: "新密码至少 6 位" };
  let nextVk;
  try {
    nextVk = crypto.vkFromRecovery(meta, key);
    if (!crypto.verifyVk(meta, nextVk)) throw new Error("校验失败");
  } catch {
    return { ok: false, error: "恢复密钥不正确" };
  }
  try {
    const nextMeta = crypto.rewrapPassword(meta, nextVk, next, hint);
    writeMeta(nextMeta);
    adoptVk(nextVk);
    unlockedByEnv = false;
    logger.ok("已用恢复密钥重置保险库密码");
    return { ok: true };
  } catch (e) {
    logger.error(`重置保险库密码失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 取出恢复密钥（仅在已解锁时允许，避免成为绕过密码的后门） */
function getRecoveryKey() {  const meta = readMeta();
  if (!meta || !isUnlocked()) return { ok: false, error: "保险库未解锁" };
  try {
    // VK 是用 RK 加密的，反过来无法从 VK 推出 RK；
    // 因此这里重新生成一把新的恢复密钥并替换旧的，把新密钥交给用户保存。
    const rk = crypto.randomBytes(crypto.KEY_LEN);
    const nextMeta = { ...meta, vkByRk: crypto.encrypt(rk, vk), updatedAt: Date.now() };
    writeMeta(nextMeta);
    return { ok: true, recoveryKey: crypto.toB64(rk) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 供界面渲染的状态快照 */
function status() {
  const meta = readMeta();
  return {
    configured: !!meta,
    unlocked: isUnlocked(),
    keychain: keychain.isAvailable(),
    hint: meta ? meta.hint || "" : "",
    byEnv: unlockedByEnv,
  };
}

/** 加密对象（未配置/未锁定时调用会抛错，调用方需先判断 ready） */
function encryptJSON(obj) {
  if (!vk) throw new Error("保险库未解锁，无法加密");
  return crypto.encryptJSON(vk, obj);
}

function decryptJSON(blob) {
  if (!vk) throw new Error("保险库未解锁，无法解密");
  return crypto.decryptJSON(vk, blob);
}

module.exports = {
  VAULT_FILE,
  KEY_FILE,
  ENV_PASSWORD,
  ENV_KEY,
  isConfigured,
  isReady,
  isUnlocked,
  setup,
  unlock,
  unlockWithRecovery,
  tryAutoUnlock,
  changePassword,
  resetPasswordWithRecovery,
  getRecoveryKey,
  lock,
  status,
  encryptJSON,
  decryptJSON,
};
