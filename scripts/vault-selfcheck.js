#!/usr/bin/env node
/**
 * Vault 加密自检脚本（纯 Node，不依赖 Electron，可直接 `node scripts/vault-selfcheck.js` 运行）
 *
 * 用途：
 *   1. 默认模式：对真实代码 src/vault/crypto.js 跑一套断言，确认加密格式/密钥结构/
 *      篡改拒读/改密/明文迁移逻辑都正确。
 *   2. --disk 模式：拿你本机真实的 storage/ 目录 + 密码，扫描磁盘是否还有明文
 *      登录态泄漏、密文能否解密，直接验证「断言 A：磁盘无明文」。
 *
 * 说明：
 *   - 本脚本只读真实代码、只读真实磁盘，不会修改任何文件。
 *   - 第 3 步「重启免密解锁」依赖 Electron 的 safeStorage/Windows DPAPI，
 *     纯 Node 起不来 GUI，所以那一步仍需你按验证清单在界面上人工确认。
 *
 * 用法：
 *   node scripts/vault-selfcheck.js
 *   node scripts/vault-selfcheck.js --disk <storageDir> <password>
 */

const path = require("path");
const fs = require("fs");
const v = require("../src/vault/crypto");

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail ? "— " + detail : ""}`);
  }
}

function expectThrow(name, fn) {
  try {
    fn();
    fail += 1;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m — 应抛错但没抛`);
  } catch {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  }
}

// ===================== 内置加密逻辑测试套件 =====================
function runSuite() {
  console.log("\x1b[36m== Vault 加密自检测试套件 ==\x1b[0m\n");

  // 1) 建库
  const { meta, vk, recoveryKey } = v.createVault("Password123", "我的提示");
  check("createVault 返回 32 字节主密钥 VK", vk.length === 32);
  check("恢复密钥为 base64 且解码 32 字节", Buffer.from(recoveryKey, "base64").length === 32);
  const allowed = ["version", "salt", "kdf", "hint", "vkByPw", "vkByRk", "verifier", "createdAt", "updatedAt"];
  check("meta 仅含预期字段（无明文 cookie/token）", Object.keys(meta).every((k) => allowed.includes(k)));
  check("meta.version === 1", meta.version === 1);
  check("kdf.maxmem 已持久化（跨 Node 版本一致）", meta.kdf && meta.kdf.maxmem === v.SCRYPT.maxmem);

  // 2) 密码解锁往返
  const vk2 = v.vkFromPassword(meta, "Password123");
  check("vkFromPassword 解出与建库一致的 VK", vk2.equals(vk));
  check("verifyVk 校验通过", v.verifyVk(meta, vk2) === true);

  // 3) 错误密码应失败
  expectThrow("错误密码 vkFromPassword 抛错（GCM 校验失败）", () => v.vkFromPassword(meta, "WrongPass"));

  // 4) 恢复密钥解锁往返
  const vkR = v.vkFromRecovery(meta, recoveryKey);
  check("vkFromRecovery 解出一致 VK", vkR.equals(vk));
  check("恢复密钥 verifyVk 通过", v.verifyVk(meta, vkR) === true);
  expectThrow("错误恢复密钥 vkFromRecovery 抛错", () => v.vkFromRecovery(meta, v.toB64(Buffer.alloc(32, 7))));

  // 5) 对象加解密往返
  const secrets = {
    cookies: [{ name: "MSAuth", value: "secret-cookie-value", domain: ".bing.com" }],
    refreshToken: "rt-very-secret",
    accessToken: "at-very-secret",
    accessTokenAt: Date.now(),
  };
  const blob = v.encryptJSON(vk, secrets);
  const back = v.decryptJSON(vk, blob);
  check("encryptJSON/decryptJSON 往返一致", JSON.stringify(back) === JSON.stringify(secrets));
  // base64 字母表里没有 '-'，所以子串 "rt-very-secret" 不可能出现在 base64 密文中
  check("密文不含明文 token（无泄漏）", !blob.includes("rt-very-secret") && !blob.includes("at-very-secret"));

  // 6) 篡改拒读（核心：GCM 完整性校验）
  const tampered = blob.slice(0, -1) + (blob.endsWith("A") ? "B" : "A");
  expectThrow("篡改密文 decryptJSON 抛错", () => v.decryptJSON(vk, tampered));

  // 7) 跨密钥隔离（A 账户密文不能被 B 账户 VK 解开）
  const otherVk = v.randomBytes(32);
  expectThrow("用错误 VK 解密抛错（账户间隔离）", () => v.decryptJSON(otherVk, blob));

  // 8) 改密码：不改 VK，旧密文仍可读；旧密码失效；恢复密钥仍有效
  const newMeta = v.rewrapPassword(meta, vk, "NewPass456", "新提示");
  check("改密后 hint 更新", newMeta.hint === "新提示");
  const vkNew = v.vkFromPassword(newMeta, "NewPass456");
  check("新密码可解锁", v.verifyVk(newMeta, vkNew) === true);
  expectThrow("旧密码改密后已失效", () => v.vkFromPassword(newMeta, "Password123"));
  const vkR2 = v.vkFromRecovery(newMeta, recoveryKey);
  check("恢复密钥改密后仍有效", v.verifyVk(newMeta, vkR2) === true);
  const back2 = v.decryptJSON(vk, blob); // VK 没变，旧密文照常可读
  check("改密不改变 VK，旧密文仍可读", JSON.stringify(back2) === JSON.stringify(secrets));

  // 9) 明文迁移（镜像 migrate.js 的变换，验证行为）
  const SECRET_FIELDS = ["cookies", "refreshToken", "accessToken", "accessTokenAt"];
  function migrateOne(raw, key) {
    const out = { ...raw };
    const secretObj = {};
    for (const k of SECRET_FIELDS) {
      if (out[k] !== undefined) secretObj[k] = out[k];
      delete out[k];
    }
    out.secrets = v.encryptJSON(key, secretObj);
    return out;
  }
  const oldState = {
    cookies: [{ name: "session", value: "v" }],
    refreshToken: "rt",
    accessToken: "at",
    accessTokenAt: 123,
    tasksDone: { sign: 20260913 },
  };
  const migrated = migrateOne(oldState, vk);
  check("迁移后 secrets 字段存在", !!migrated.secrets);
  check("迁移后 cookies 明文被移除", migrated.cookies === undefined);
  check("迁移后 refreshToken 明文被移除", migrated.refreshToken === undefined);
  check("迁移后非敏感字段保留", JSON.stringify(migrated.tasksDone) === JSON.stringify({ sign: 20260913 }));
  const restored = v.decryptJSON(vk, migrated.secrets);
  check("迁移后 secrets 可还原登录态", restored.refreshToken === "rt" && restored.cookies[0].value === "v");

  // 10) 锁定态（无 VK）拒绝覆写——migrate.js 用 vault.isUnlocked() 兜底
  expectThrow("未解锁(vk=null)时加密抛错（migrate 据此拒绝覆写）", () => v.encryptJSON(null, secrets));

  console.log(`\n\x1b[36m结果: ${pass} 通过 / ${fail} 失败\x1b[0m`);
  return fail;
}

// ===================== 真实磁盘扫描 =====================
function diskScan(storageDir, password) {
  console.log(`\x1b[36m== 磁盘扫描: ${storageDir} ==\x1b[0m\n`);
  const vaultFile = path.join(storageDir, "vault.json");
  if (!fs.existsSync(vaultFile)) {
    console.log("未找到 vault.json，说明尚未启用保险库；跳过磁盘扫描。");
    console.log("先在应用里完成加密设置，再带密码重跑本脚本。");
    return 1;
  }
  const meta = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
  let vk;
  try {
    vk = v.vkFromPassword(meta, password);
  } catch {
    console.log("\x1b[31m密码错误，无法解锁保险库。\x1b[0m");
    return 1;
  }
  if (!v.verifyVk(meta, vk)) {
    console.log("\x1b[31m解锁校验失败。\x1b[0m");
    return 1;
  }
  console.log("保险库解锁成功，开始扫描账户目录...\n");

  const accountsDir = path.join(storageDir, "accounts");
  if (!fs.existsSync(accountsDir)) {
    console.log("无 accounts 目录，无需扫描。");
    return 0;
  }
  let leak = 0;
  let okCount = 0;
  for (const ent of fs.readdirSync(accountsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const sf = path.join(accountsDir, ent.name, "state.json");
    if (!fs.existsSync(sf)) continue;
    const raw = JSON.parse(fs.readFileSync(sf, "utf8"));
    const hasPlainCookies = Array.isArray(raw.cookies) && raw.cookies.length > 0;
    const hasPlainToken = !!(raw.refreshToken || raw.accessToken);
    if (hasPlainCookies || hasPlainToken) {
      leak += 1;
      console.log(`  \x1b[31m✗ ${ent.name}: state.json 仍有明文登录态（cookies=${hasPlainCookies}, token=${hasPlainToken}）\x1b[0m`);
    } else if (raw.secrets) {
      try {
        v.decryptJSON(vk, raw.secrets);
        okCount += 1;
        console.log(`  \x1b[32m✓ ${ent.name}: secrets 密文可解密，磁盘无明文\x1b[0m`);
      } catch {
        leak += 1;
        console.log(`  \x1b[31m✗ ${ent.name}: secrets 密文损坏，无法解密\x1b[0m`);
      }
    } else {
      console.log(`  · ${ent.name}: 无 secrets 也无明文（新账户/未登录，正常）`);
    }
  }
  if (leak === 0) {
    console.log(`\n\x1b[32m磁盘扫描通过：${okCount} 个账户密文完好，无明文泄漏。\x1b[0m`);
  } else {
    console.log(`\n\x1b[31m磁盘扫描发现 ${leak} 处明文泄漏！\x1b[0m`);
  }
  return leak;
}

// ===================== 入口 =====================
function main() {
  const mode = process.argv[2];
  if (mode === "--disk") {
    const dir = process.argv[3] || path.join(__dirname, "..", "storage");
    const pw = process.argv[4];
    if (!pw) {
      console.log("用法: node scripts/vault-selfcheck.js --disk <storageDir> <password>");
      process.exit(1);
    }
    process.exitCode = diskScan(dir, pw) ? 1 : 0;
  } else {
    process.exitCode = runSuite() ? 1 : 0;
  }
}

main();
