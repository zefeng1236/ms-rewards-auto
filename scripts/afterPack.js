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
  await rcedit(exePath, { icon: iconPath });
  console.log('[afterPack] icon set done');
};
