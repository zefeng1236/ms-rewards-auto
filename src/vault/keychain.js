/**
 * 系统钥匙串适配器（唯一允许 import electron 的保险库模块）
 *
 * 作用：把主密钥(VK)托管给操作系统，实现「首次设密码之后免密启动」。
 *
 * 为什么必须懒加载 + 运行时探测：
 *   - Windows/macOS：electron.safeStorage 可用（底层是 DPAPI / Keychain）。
 *   - 无桌面的 Linux（将来的 Docker 版）：没有 keyring 守护进程和 D-Bus 会话，
 *     safeStorage 直接不可用；若在此处静态 require("electron")，CLI 版会崩。
 *   所以这里一律 try/catch 降级：不可用时所有方法返回 false/null，
 *   上层自动退回「用密码或环境变量解锁」，功能不缺失，只是需要输一次密码。
 */
const fs = require("fs");
const path = require("path");

/** 缓存探测结果：null=未探测，false=不可用，object=safeStorage 实例 */
let cached = null;

function storage() {
  if (cached !== null) return cached;
  try {
    // eslint-disable-next-line global-require
    const { safeStorage } = require("electron");
    cached = safeStorage || false;
  } catch {
    cached = false; // 非 Electron 环境（CLI/Docker）
  }
  return cached;
}

/** 当前环境的系统钥匙串是否真的能用（每次调用都重新探测，避免状态漂移） */
function isAvailable() {
  const s = storage();
  if (!s || typeof s.isEncryptionAvailable !== "function") return false;
  try {
    return !!s.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 托管主密钥；keyFile 用于存放系统加密后的密文 */
function saveKey(keyFile, vkBase64) {
  if (!isAvailable()) return false;
  try {
    const buf = storage().encryptString(vkBase64);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, buf);
    return true;
  } catch {
    return false;
  }
}

/** 读回主密钥；系统用户不匹配/文件被换/密文损坏时返回 null */
function loadKey(keyFile) {
  if (!isAvailable()) return null;
  try {
    if (!fs.existsSync(keyFile)) return null;
    return storage().decryptString(fs.readFileSync(keyFile));
  } catch {
    return null;
  }
}

/** 丢弃托管（用户在界面点「锁定」时调用） */
function clearKey(keyFile) {
  try {
    if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isAvailable, saveKey, loadKey, clearKey };
