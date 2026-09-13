/**
 * 存量数据迁移：把旧版明文登录态搬进保险库，并清掉遗留的浏览器 profile
 *
 * 两件事必须一起做，否则加密只是表面功夫：
 *   1. state.json 里的 cookies / refreshToken / accessToken 明文 -> 加密成 secrets 字段
 *   2. accounts/<id>/profile/ 目录 -> 删除
 *      那是旧版 Playwright 持久化 profile，Chromium 在里面也写了一份明文 Cookie。
 *      改成「临时 profile + 注入 Cookie」后它已不再使用，留着就是明文后门。
 */
const fs = require("fs");
const path = require("path");
const sp = require("../storage-path");
const vault = require("./index");
const logger = require("../logger");

/** 属于敏感信息、需要收进保险库的字段 */
const SECRET_FIELDS = ["cookies", "refreshToken", "accessToken", "accessTokenAt"];

function hasPlaintextSecrets(raw) {
  return (
    (Array.isArray(raw.cookies) && raw.cookies.length > 0) ||
    !!(raw.refreshToken || "") ||
    !!(raw.accessToken || "")
  );
}

/** 迁移单个账户目录；返回 'encrypted' | 'skipped' | 'locked' */
function migrateAccountDir(dir) {
  const file = path.join(dir, "state.json");
  if (!fs.existsSync(file)) return "skipped";
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "skipped";
  }
  if (!raw || typeof raw !== "object") return "skipped";

  // 已有密文：说明迁移过，只需要清理遗留 profile
  if (raw.secrets) return "skipped";
  if (!hasPlaintextSecrets(raw)) return "skipped";

  if (!vault.isConfigured()) return "skipped";
  if (!vault.isUnlocked()) return "locked";

  const secrets = {};
  for (const k of SECRET_FIELDS) {
    if (raw[k] !== undefined) secrets[k] = raw[k];
    delete raw[k];
  }
  try {
    raw.secrets = vault.encryptJSON(secrets);
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
    return "encrypted";
  } catch (e) {
    logger.error(`加密账户状态失败: ${e.message}`);
    return "skipped";
  }
}

/**
 * 迁移全部账户并清理遗留 profile
 * @returns {{encrypted:number, profiles:number, locked:boolean}}
 */
function migrateAll() {
  const accountsDir = sp.accountsDir;
  const out = { encrypted: 0, profiles: 0, locked: false };
  if (!fs.existsSync(accountsDir)) return out;

  let entries = [];
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(accountsDir, ent.name);
    const r = migrateAccountDir(dir);
    if (r === "encrypted") out.encrypted++;
    else if (r === "locked") out.locked = true;

    // 清理遗留的持久化 profile（明文 Cookie）
    const prof = path.join(dir, "profile");
    if (fs.existsSync(prof)) {
      try {
        fs.rmSync(prof, { recursive: true, force: true });
        out.profiles++;
      } catch (e) {
        logger.warn(`清理遗留浏览器目录失败: ${e.message}`);
      }
    }
  }

  if (out.encrypted > 0) {
    logger.ok(`已将 ${out.encrypted} 个账户的登录态加密存储`);
  }
  if (out.profiles > 0) {
    logger.info(`已清理 ${out.profiles} 个遗留的明文浏览器目录`);
  }
  if (out.locked) {
    logger.warn("存在未加密的账户登录态，解锁后将自动完成加密");
  }
  return out;
}

module.exports = { SECRET_FIELDS, migrateAll, migrateAccountDir, hasPlaintextSecrets };
