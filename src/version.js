"use strict";
/**
 * 版本号的唯一出口。
 *
 * 分两层，各司其职：
 *   1. package.json 的 `version` 保持三段合法 semver（0.9.4）—— npm / CI / Docker 都要求合法 semver，
 *      塞四段（0.9.4.1）会被判定为非法版本号。
 *   2. 「小版本号」（每次交付递增的一位）放在 package.json **顶层** `buildNumber`，
 *      由 scripts/beforePack.js 同步给 electron-builder，拼成 buildVersion = "0.9.4.1"，
 *      用于安装包文件名（artifactName 的 ${buildVersion}）与 exe 的 Windows FileVersion。
 *      ⚠️ 必须放顶层：`build` 段会被 electron-builder 从打进 asar 的 package.json 里
 *      剔除，运行时读不到（曾导致标题退回三段版本）。
 *
 * 窗口标题与健康检查也读这里，避免同一个版本号在三个地方各写各的、越走越散。
 */
const pkg = require("../package.json");

/** 小版本号（无则返回空串）。必须是顶层字段：`build` 段会被 electron-builder 剔除。 */
function buildNumber() {
  const n = pkg.buildNumber;
  return n == null ? "" : String(n).trim();
}

/**
 * 完整展示版本。
 *
 * 小版本号为 "0" 时视为**正式版**，只输出三段（0.10.0）—— 正式发布的版本号不该
 * 拖一条 ".0" 尾巴；后续热修把 buildNumber 递增到 1、2… 才回到四位（0.10.0.1）。
 */
function displayVersion() {
  const n = buildNumber();
  return n && n !== "0" ? `${pkg.version}.${n}` : String(pkg.version);
}

module.exports = { displayVersion, buildNumber, baseVersion: String(pkg.version) };
