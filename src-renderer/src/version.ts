/**
 * 渲染层展示版本。
 *
 * ⚠️ 必须与 package.json 的 version + buildNumber 保持同步 ——
 * selfcheck 有守卫比对（渲染层 version.ts 与 package.json 版本同步），
 * bump 版本时漏改这里会直接门禁变红。
 */
export const APP_VERSION = "0.13.0";
/** 0 = 正式版（展示干净三段 v0.10.0）；热修时递增到 1、2… 才显示 v0.10.0.1 */
export const BUILD_NUMBER = 0;
export const DISPLAY_VERSION = BUILD_NUMBER ? `${APP_VERSION}.${BUILD_NUMBER}` : APP_VERSION;
