#!/usr/bin/env node
/**
 * 版本号 bump 工具 —— 把「发版时容易漏改的六处版本号」收敛成一条命令。
 *
 * 用法：
 *   node scripts/bump-version.js 0.13.10          # 只改主版本（buildNumber 保持不变）
 *   node scripts/bump-version.js 0.13.10 --build 1 # 同时把小版本号置为 1
 *   node scripts/bump-version.js --dry 0.13.10     # 预演，不落盘
 *   node scripts/bump-version.js --check           # 只校验一致性，不改任何文件
 *
 * 同步的六处（selfcheck【12】会逐一比对，漏一处门禁变红）：
 *   1. package.json            version / buildNumber（buildNumber 是唯一真源）
 *   2. package-lock.json       根 version + packages[""].version（两处）
 *   3. src-renderer/src/version.ts                 APP_VERSION / BUILD_NUMBER
 *   4. src-renderer/src/views/About.tsx            APP_VERSION
 *   5. src-renderer/src/api/mock.ts                currentVersion
 *   6. README.md                                   顶部「当前版本：Vx.y.z」
 *   （另：CHANGELOG.md 若缺 ## 新版本 章节则自动补一个待填骨架，否则门禁会红）
 *
 * ⚠️ docker-compose.yml 的 image 已改为 :latest（配合 Watchtower 自动更新），
 *    不再随版本号同步 —— 版本 tag 由 CI 在推送 ghcr 时按 package.json 动态生成。
 *
 * ⚠️ 注意：CHANGELOG.md 里旧版本章节的镜像 tag 属于历史记录，不能改。
 *    所以这里只在新版本号「不存在」时插入骨架，不做全局替换。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* ---------------- 参数解析 ---------------- */
const argv = process.argv.slice(2);
const dry = argv.includes("--dry") || argv.includes("--dry-run");
const checkOnly = argv.includes("--check");
const buildIdx = argv.findIndex((a) => a === "--build" || a === "-b");
const nextBuild = buildIdx >= 0 ? String(argv[buildIdx + 1] || "").trim() : null;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !(buildIdx >= 0 && i === buildIdx + 1) && a !== "-b"
);
const targetVersion = positional[0];

const SEMVER = /^\d+\.\d+\.\d+$/;

if (!checkOnly && !targetVersion) {
  console.error("用法: node scripts/bump-version.js <x.y.z> [--build N] [--dry] [--check]");
  process.exit(2);
}
if (targetVersion && !SEMVER.test(targetVersion)) {
  console.error(`版本号格式非法: ${JSON.stringify(targetVersion)}（要求 x.y.z，例如 0.13.10）`);
  process.exit(2);
}
if (nextBuild !== null && !/^\d+$/.test(nextBuild)) {
  console.error(`buildNumber 必须为纯数字，实际 ${JSON.stringify(nextBuild)}`);
  process.exit(2);
}

/* ---------------- 小工具 ---------------- */
const log = [];
function rep(file, label, from, to, contentTransform) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    log.push({ file, label, status: "MISS", note: "文件不存在" });
    return false;
  }
  const src = fs.readFileSync(abs, "utf8");
  const out = contentTransform(src);
  if (out === null) {
    log.push({ file, label, status: "MISS", note: `未匹配到「${from}」` });
    return false;
  }
  if (out === src) {
    log.push({ file, label, status: "SAME", note: "已是目标值" });
    return true;
  }
  if (!dry) fs.writeFileSync(abs, out, "utf8");
  log.push({ file, label, status: dry ? "DRY" : "OK" });
  return true;
}

/** 把「旧版本号」精确替换为「新版本号」，只替换第一处 / 全部 */
function swapAll(src, from, to) {
  if (!src.includes(from)) return null;
  return src.split(from).join(to);
}

/* ---------------- --check 模式 ---------------- */
if (checkOnly) {
  const pkg = require(path.join(ROOT, "package.json"));
  const expected = (pkg.version || "").trim();
  const bNum = String(pkg.buildNumber || "0");
  const items = [];
  const add = (name, ok, detail) => items.push({ name, ok, detail });

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  add("package-lock.json 根 version", lock.version === expected, `${lock.version} vs ${expected}`);
  add(
    'package-lock.json packages[""]',
    lock.packages?.[""]?.version === expected,
    `${lock.packages?.[""]?.version} vs ${expected}`
  );
  // ⚠️ 反向守卫：依赖条目的 version 绝不能等于项目版本号。
  // 用「全局替换」bump lock 文件会把 531 个依赖版本一起改掉，
  // 届时 `npm ci` 报 EUSAGE、Docker 构建直接失败（0.13.10 发版时踩过）。
  const lockRaw = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  const depVerMatches = (lockRaw.match(new RegExp(`"version":\\s*"${expected.replace(/\./g, "\\.")}"`, "g")) || [])
    .length;
  add(
    "package-lock.json 依赖版本未被污染",
    depVerMatches === 2,
    `出现 ${depVerMatches} 处（应恰好 2 处：根 + packages[""]）`
  );

  const verSrc = fs.readFileSync(path.join(ROOT, "src-renderer", "src", "version.ts"), "utf8");
  const vApp = (verSrc.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];
  const vBuild = (verSrc.match(/BUILD_NUMBER\s*=\s*(\d+)/) || [])[1];
  add("version.ts APP_VERSION", vApp === expected, `${vApp} vs ${expected}`);
  add("version.ts BUILD_NUMBER", String(vBuild) === bNum, `${vBuild} vs ${bNum}`);

  const aboutSrc = fs.readFileSync(
    path.join(ROOT, "src-renderer", "src", "views", "About.tsx"),
    "utf8"
  );
  const aboutV = (aboutSrc.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];
  add("About.tsx APP_VERSION", aboutV === expected, `${aboutV} vs ${expected}`);

  const mockSrc = fs.readFileSync(
    path.join(ROOT, "src-renderer", "src", "api", "mock.ts"),
    "utf8"
  );
  // currentVersion 允许两种合法形态：
  //   ① 字面量 `"x.y.z"` —— 与 package.json 同步
  //   ② `DISPLAY_VERSION` —— 单源到 APP_VERSION/BUILD_NUMBER，自动同步
  //   0.14 起要求强单源（mock 写死"0.14.0"会让装 0.13.x 的用户看到「侧边栏 0.13.x / 检查更新 0.14」对不齐）
  const mockVLiteral = (mockSrc.match(/currentVersion:\s*"([^"]+)"/) || [])[1];
  const mockUsesDisplay =
    /currentVersion:\s*DISPLAY_VERSION\b/.test(mockSrc) &&
    !/currentVersion:\s*"[^"]+"/.test(mockSrc);
  add(
    "mock.ts currentVersion",
    mockVLiteral === expected || mockUsesDisplay,
    mockUsesDisplay
      ? `DISPLAY_VERSION（与 package.json 单源） vs ${expected}`
      : `${mockVLiteral} vs ${expected}`
  );

  const readmeSrc = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const readmeOk = readmeSrc.includes(`当前版本：V${expected}`);
  add(
    "README.md 顶部版本横幅",
    readmeOk,
    readmeOk ? `当前版本：V${expected}` : `未找到「当前版本：V${expected}」`
  );

  const changelogSrc = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const clOk = new RegExp(`^## ${expected.replace(/\./g, "\\.")}\\s*$`, "m").test(changelogSrc);
  add("CHANGELOG.md 新版本章节", clOk, clOk ? `## ${expected}` : `未找到「## ${expected}」`);

  const bad = items.filter((i) => !i.ok);
  for (const i of items) console.log(`${i.ok ? "  ok  " : " FAIL "} ${i.name}${i.detail ? `  (${i.detail})` : ""}`);
  console.log(
    `\n版本一致性：${expected}${bNum !== "0" ? `.${bNum}` : ""} —— ${items.length - bad.length}/${items.length} 通过`
  );
  process.exit(bad.length ? 1 : 0);
}

/* ---------------- bump 主流程 ---------------- */
const pkgAbs = path.join(ROOT, "package.json");
const pkgRaw = fs.readFileSync(pkgAbs, "utf8");
const oldVersion = (pkgRaw.match(/"version":\s*"([^"]+)"/) || [])[1];
const oldBuild = String((pkgRaw.match(/"buildNumber":\s*"([^"]+)"/) || [])[1] || "0");
const finalBuild = nextBuild === null ? oldBuild : nextBuild;

if (!oldVersion) {
  console.error("package.json 中未找到顶层 version");
  process.exit(2);
}
console.log(
  `bump: ${oldVersion}${oldBuild !== "0" ? `.${oldBuild}` : ""} → ${targetVersion}${
    finalBuild !== "0" ? `.${finalBuild}` : ""
  }${dry ? "   [--dry 预演]" : ""}\n`
);

/* 1. package.json —— 顶层 version + buildNumber
   ⚠️ 绝不能写进 build 段（会被 electron-builder 黑名单剔除，标题退回三段） */
rep("package.json", "version / buildNumber", oldVersion, targetVersion, (s) => {
  let out = s.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${targetVersion}"`);
  out = out.replace(/^(\s*"buildNumber":\s*)"[^"]+"/m, `$1"${finalBuild}"`);
  return out === s ? null : out;
});

/* 2. package-lock.json —— 只改根与 packages[""] 两处
   ⚠️⚠️ 绝不能全局替换 `"version": "..."`！lock 文件里每个依赖条目都有自己的
   version 字段，全局替换会把 531 个依赖版本全改成项目版本号，导致
   `npm ci` 报 EUSAGE（lock 与 package.json 不同步），Docker 构建直接失败。
   （0.13.10 发版时踩过，服务器构建失败才发现。）
   这里用「锚定结构」的写法：只改紧跟 name 之后的第一个 version，
   以及 packages 段下 "" 键里的 version。 */
rep("package-lock.json", "version ×2（仅根与 packages[\"\"]）", oldVersion, targetVersion, (s) => {
  const lines = s.split("\n");
  let hit = 0;
  for (let i = 0; i < lines.length; i++) {
    // 根 version：文件最开头 5 行内
    if (i < 5 && /^\s{2}"version":\s*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/("version":\s*)"[^"]+"/, `$1"${targetVersion}"`);
      hit++;
      continue;
    }
    // packages[""] 的 version：紧跟在第 2 个 `"name": "ms-rewards-auto",` 之后的 version
    if (/"name":\s*"ms-rewards-auto"/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^\s{6}"version":\s*"/.test(lines[j])) {
          lines[j] = lines[j].replace(/("version":\s*)"[^"]+"/, `$1"${targetVersion}"`);
          hit++;
          break;
        }
      }
    }
  }
  if (hit !== 2) {
    throw new Error(`package-lock.json 命中 ${hit} 处（应为 2）—— 结构变了，请人工确认`);
  }
  return lines.join("\n");
});

/* 3. 渲染层 version.ts —— APP_VERSION + BUILD_NUMBER */
rep("src-renderer/src/version.ts", "APP_VERSION / BUILD_NUMBER", oldVersion, targetVersion, (s) => {
  let out = s.replace(/(APP_VERSION\s*=\s*)"[^"]+"/, `$1"${targetVersion}"`);
  out = out.replace(/(BUILD_NUMBER\s*=\s*)\d+/, `$1${finalBuild}`);
  return out === s ? null : out;
});

/* 4. About.tsx —— APP_VERSION */
rep("src-renderer/src/views/About.tsx", "APP_VERSION", oldVersion, targetVersion, (s) => {
  const out = s.replace(/(APP_VERSION\s*=\s*)"[^"]+"/, `$1"${targetVersion}"`);
  return out === s ? null : out;
});

/* 5. mock.ts —— currentVersion */
rep("src-renderer/src/api/mock.ts", "currentVersion", oldVersion, targetVersion, (s) => {
  const out = s.replace(/(currentVersion:\s*)"[^"]+"/, `$1"${targetVersion}"`);
  return out === s ? null : out;
});

/* 6. README.md —— 顶部版本横幅 */
rep("README.md", "版本横幅", oldVersion, targetVersion, (s) => {
  const out = swapAll(s, `当前版本：V${oldVersion}`, `当前版本：V${targetVersion}`);
  return out === null ? null : out;
});

/* 8. CHANGELOG.md —— 缺新版本章节则补骨架（旧章节里的镜像 tag 属历史，不动） */
{
  const abs = path.join(ROOT, "CHANGELOG.md");
  const src = fs.readFileSync(abs, "utf8");
  const hasSection = new RegExp(`^## ${targetVersion.replace(/\./g, "\\.")}\\s*$`, "m").test(src);
  if (hasSection) {
    log.push({ file: "CHANGELOG.md", label: `## ${targetVersion}`, status: "SAME", note: "章节已存在" });
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const stub =
      `## ${targetVersion}\n\n` +
      `发布日期：${today} · Windows 安装包 \`MS-Rewards-Auto-Setup-${targetVersion}.exe\`\n\n` +
      `<!-- TODO: 补写本版变更说明（至少一段概述 + 变更列表），否则发版说明不完整 -->\n\n`;
    // 插到第一个 "## " 章节之前（保持时间倒序）
    const idx = src.search(/^## /m);
    const out = idx >= 0 ? src.slice(0, idx) + stub + src.slice(idx) : `${src}\n${stub}`;
    if (!dry) fs.writeFileSync(abs, out, "utf8");
    log.push({
      file: "CHANGELOG.md",
      label: `## ${targetVersion}`,
      status: dry ? "DRY" : "STUB",
      note: "已插入待填骨架 —— 记得补写变更说明",
    });
  }
}

/* ---------------- 报告 ---------------- */
const W = Math.max(...log.map((l) => l.file.length));
for (const l of log) {
  const mark = l.status === "OK" || l.status === "SAME" || l.status === "STUB" ? " ok " : l.status === "DRY" ? "dry " : "!!  ";
  console.log(
    `${mark} ${l.file.padEnd(W)}  ${String(l.status).padEnd(5)} ${l.label}${l.note ? `  — ${l.note}` : ""}`
  );
}
const missed = log.filter((l) => l.status === "MISS");
if (missed.length) {
  console.log(`\n⚠️ 有 ${missed.length} 处未命中，请人工确认（版本号文本可能已被改动过）`);
}
console.log(
  `\n下一步：node scripts/bump-version.js --check  然后再跑门禁三件套（typecheck + test + verify-pack）`
);
