const fs = require("fs");
const path = require("path");
const sp = require("./storage-path");
const accounts = require("./account");
const appearance = require("./appearance");
const vault = require("./vault");
const setup = require("./setup");
const logger = require("./logger");

/**
 * 「清空账号数据」：忘记密码又没有恢复密钥时的最后退路。
 *
 * 此时保险库里的登录态已经无法解开（密码与密钥都没了），留着只是一个
 * 永远解不开的锁 —— 所以这里把保险库本身一并删除，让软件回到可用状态。
 *
 * 删除：
 *   - storage/accounts/**        全部账户目录（含加密后的登录态 secrets、任务进度、遗留 profile）
 *   - logs/accounts/**           各账户的历史日志
 *   - logs/*.jsonl               旧版按天日志（若存在）
 *   - storage/vault.json         `.vaultkey`  保险库配置与钥匙串托管
 *   - storage/profile/           旧版遗留的明文浏览器目录
 *   - storage/cache/  storage/tmp/  运行缓存
 *   - storage/state.json         旧版全局状态残留
 *   - setup.json 的完成状态       重置为「未完成」，下次启动重新走首次启动向导
 *
 * 保留（个性化与系统行为设置）：
 *   - appearance.json            主题 / 壁纸 / 玻璃效果 / 模糊暗化等，全部保留
 *   - launch.json                开机自启、托盘、启动延迟
 *   - global-config.json         推送渠道、搜索设置等业务配置
 *
 * 例外：壁纸 API 密钥（appearance.json 的 bgUnsplashKey）属于第三方凭据，
 *       按要求一并清除（其余壁纸配置如类型、直链、旋转间隔都保留）。
 *
 * 重置向导状态的原因：账号与保险库都被删了，此时桌面版/Web 版都应回到
 * 「首次安装」的样子 —— 重新走一遍向导（含重新建库），而不是进到一个
 * 没有账号、也没有保险库的空壳主界面。
 *
 * @returns {{ok:boolean, accounts:number, logs:number, vault:boolean, wallpaperKey:boolean, wizardReset:boolean, error?:string}}
 */
function wipeAccountData() {
  const out = {
    ok: true,
    accounts: 0,
    logs: 0,
    vault: false,
    wallpaperKey: false,
    wizardReset: false,
  };

  const remove = (target) => {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (e) {
      logger.warn(`清除 ${target} 失败: ${e.message}`);
      return false;
    }
  };

  try {
    // 1. 账户：先清各自的历史日志缓冲与磁盘目录，再逐个移除
    for (const a of accounts.list()) {
      logger.clearAccountHistory(a.id);
      accounts.remove(a.id);
      out.accounts++;
    }
    // 目录整体兜底（含 index.json）
    remove(sp.accountsDir);

    // 2. 日志：账户历史日志目录 + 旧版按天 jsonl
    const logsRoot = path.join(sp.storageRoot, "..", "logs");
    const accountLogs = path.join(logsRoot, "accounts");
    const before = countDirs(accountLogs);
    if (remove(accountLogs)) out.logs = before;
    try {
      for (const name of fs.readdirSync(logsRoot)) {
        if (name.endsWith(".jsonl")) remove(path.join(logsRoot, name));
      }
    } catch {}

    // 3. 保险库本身：密码与密钥都丢了，它已无法解开，留着只会永远锁门
    vault.lock();
    remove(vault.VAULT_FILE);
    remove(vault.KEY_FILE);
    out.vault = !fs.existsSync(vault.VAULT_FILE);

    // 4. 重置向导状态：账号与保险库都已删除，应回到「首次安装」的样子重新引导。
    //    必须放在删掉 vault.json 之后 —— setup.get() 的升级兼容迁移一旦发现
    //    vault.json 存在，就会把 done 补写回 true，顺序反了会互相打架。
    try {
      setup.set({ done: false });
      out.wizardReset = true;
    } catch (e) {
      logger.warn(`重置向导状态失败: ${e.message}`);
    }

    // 5. 遗留明文目录与缓存
    remove(path.join(sp.storageRoot, "profile"));
    remove(path.join(sp.storageRoot, "cache"));
    remove(path.join(sp.storageRoot, "tmp"));
    remove(sp.resolve("state.json"));

    // 6. 保留个性化数据，但清掉其中的第三方凭据（壁纸 API 密钥）
    const ap = appearance.get();
    if (ap.bgUnsplashKey) {
      appearance.set({ bgUnsplashKey: "" });
      out.wallpaperKey = true;
    }

    logger.ok(
      `已清空账号数据：${out.accounts} 个账户、${out.logs} 份历史日志${
        out.vault ? "，加密保险库已移除" : ""
      }${out.wizardReset ? "，向导状态已重置" : ""}（个性化设置已保留）`
    );
    return out;
  } catch (e) {
    logger.error(`清空账号数据失败: ${e.message}`);
    return { ...out, ok: false, error: e.message };
  }
}

/** 数一数目录下有多少个子目录（用于汇总信息） */
function countDirs(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

module.exports = { wipeAccountData };
