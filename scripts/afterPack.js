const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.resolve(context.packager.projectDir, 'build', 'icon.ico');

  if (!fs.existsSync(iconPath)) {
    console.warn(`[afterPack] icon not found: ${iconPath}`);
    return;
  }
  if (!fs.existsSync(exePath)) {
    console.warn(`[afterPack] executable not found: ${exePath}`);
    return;
  }

  console.log(`[afterPack] setting icon for ${exePath}`);
  /**
   * 重试 + 容错（2026-11-22 踩到）。
   *
   * electron-builder 刚把 exe 写出来时，杀软扫描会短暂持有句柄，rcedit 改资源会报
   * `Fatal error: Unable to commit changes` 直接炸掉整个打包（本机实测：同一 exe 手动
   * 跑 rcedit 立刻成功，说明只是时序问题）。图标属于锦上添花 —— 重试 3 次仍失败就
   * 告警放过，不能让一个图标把发版卡死。
   */
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      await rcedit(exePath, { icon: iconPath });
      console.log("[afterPack] icon set done");
      return;
    } catch (e) {
      const msg = String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 140);
      console.warn(`[afterPack] 设置图标失败（第 ${i}/${attempts} 次）：${msg}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  console.warn("[afterPack] 图标设置最终失败，已放过（不影响功能与签名，仅资源图标可能不是自定义图标）");
};
