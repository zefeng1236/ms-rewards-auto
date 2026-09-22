"use strict";
/**
 * 把小版本号同步给 electron-builder。
 *
 * 为什么需要这个钩子：
 *   electron-builder 在把 package.json 打进 asar 时会做一次清理（fileTransformer
 *   cleanupPackageJson），黑名单里含 "build" —— 所以写在 `build` 段里的任何东西
 *   （包括 build.buildNumber）打包后运行时都读不到。曾经因此踩坑：安装包文件名是
 *   0.9.4.1，但窗口标题退回 0.9.4，因为 src/version.js 读的是已被剔除的 build 段。
 *
 * 现在的唯一真源：package.json 顶层的 "buildNumber"（不在黑名单里，能进 asar，
 * 运行时读得到）。这里把它同步成 electron-builder 的 buildVersion / buildNumber，
 * 用于安装包文件名（artifactName 的 ${buildVersion} 宏）与 exe 的 Windows FileVersion。
 *
 * 递增小版本号时只需改顶层那一个数字。
 */
const path = require("path");

module.exports = async function beforePack(context) {
  const pkg = require(path.join(context.packager.projectDir, "package.json"));
  const buildNumber = String(pkg.buildNumber == null ? "" : pkg.buildNumber).trim();
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(
      `package.json 顶层 buildNumber 缺失或不是纯数字：${JSON.stringify(pkg.buildNumber)}（应为如 "1"）`
    );
  }
  const appInfo = context.packager.appInfo;
  appInfo.buildNumber = buildNumber;
  // buildNumber 为 "0" = 正式版：文件名与 FileVersion 都用干净三段（0.10.0），
  // 后续热修递增到 1、2… 才拼成四位（0.10.0.1）。与 version.js 的 displayVersion 同规则。
  appInfo.buildVersion =
    buildNumber === "0" ? appInfo.version : `${appInfo.version}.${buildNumber}`;
  console.log(`[beforePack] 小版本号 ${buildNumber} → buildVersion ${appInfo.buildVersion}`);
};
