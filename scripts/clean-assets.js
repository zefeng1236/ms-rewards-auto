/**
 * 清理 gui-react/assets 里未被引用的旧构建产物
 *
 * 背景：vite 的 outDir（gui-react/）在 root（src-renderer/）之外，
 * 且 emptyOutDir 被显式关闭（见 vite.config.ts 注释：避免沙箱安全删除守护
 * 拦截大量文件删除）。因此每次 build 都会留下上一版的 index-*.js / index-*.css，
 * 越积越多（历史提交 95b77dc 就专门清理过一次）。
 *
 * 这里只按 index.html 的实际引用做精准删除（通常 1~3 个文件），
 * 不做整目录清空，规避上述守护拦截。
 *
 * 用法: node scripts/clean-assets.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "gui-react");
const ASSETS = path.join(OUT, "assets");
const HTML = path.join(OUT, "index.html");

if (!fs.existsSync(HTML) || !fs.existsSync(ASSETS)) {
  console.log("[clean] 未找到 gui-react/index.html 或 assets/，跳过");
  process.exit(0);
}

const html = fs.readFileSync(HTML, "utf8");
const used = new Set([...html.matchAll(/assets\/([^"']+)/g)].map((m) => m[1]));

let removed = 0;
let freed = 0;
for (const f of fs.readdirSync(ASSETS)) {
  // 只清理 vite 生成的带 hash 产物，避免误删手工资源
  if (!/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(f)) continue;
  if (used.has(f)) continue;
  const p = path.join(ASSETS, f);
  const size = fs.statSync(p).size;
  try {
    fs.rmSync(p, { force: true });
    removed++;
    freed += size;
    console.log(`[clean] 删除孤儿产物 ${f} (${(size / 1024).toFixed(1)}KB)`);
  } catch (e) {
    console.log(`[clean] 删除失败 ${f}: ${e.message}`);
  }
}

console.log(
  removed > 0
    ? `[clean] 共清理 ${removed} 个孤儿产物，释放 ${(freed / 1024).toFixed(1)}KB`
    : "[clean] 没有需要清理的孤儿产物"
);
process.exit(0);
