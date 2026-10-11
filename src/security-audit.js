const path = require("path");
const fs = require("fs");
const sp = require("./storage-path");

/**
 * 安全审计日志（2026-10-11 安全中心第二层）。
 *
 * 回答一个用户随时会问的问题：**这台软件到底动了我什么？**
 * 删了哪些文件、起了什么子进程、哪些越界操作被拦下了 —— 都能回看。
 *
 * ## 为什么不是「直接看 app.log」
 * app.log 是给人看的运行日志，会滚动、会按保留期删、格式是文本行。
 * 审计要的是**结构化 + 不轻易丢 + 能查"谁在什么时候动了什么"**，
 * 两者用途与生命周期都不同，所以独立一份。
 *
 * ## 三条自我约束（这模块自己不能成为新的攻击面）
 * ① **写失败绝不抛**。审计是旁路，不能因为磁盘满/权限问题把主流程带崩 ——
 *    全部包在 try/catch 里，失败就静默放弃这条记录。
 * ② **不做"防篡改"的自欺欺人**。文件就在 storage 下，
 *    真拿到写权限的人改了它照样能改。真要防篡改得走远程日志或 OS 审计日志，
 *    那是另一回事（见下方 TODO 说明），现在不假装有。
 * ③ **默认过滤程序自己的缓存目录**。`fingerprint-chromium/`、`tmp/`、
 *    `fp-download*` 这些是内核解压与浏览器临时 profile —— 一次内核切换
 *    能产生几百次 rmSync，全记下来会把真正的记录淹掉。
 *
 * @see 权限策略在 security-policy.js，两者配套：策略决定「要不要问」，本模块负责「记下来」。
 */

const AUDIT_FILE = () => sp.resolve("security-audit.jsonl");

/** 单文件上限，超过就滚动（保留 3 份历史） */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_ROTATIONS = 3;

/** 读取界面一次最多返回多少条 */
const MAX_READ = 500;

/**
 * 这些前缀下的删除属于程序自管理资源，不记入审计。
 * 理由见文件头约束③：一次内核切换几百次删除会把真记录淹掉。
 */
const QUIET_PREFIXES = [
  "fingerprint-chromium",
  "fingerprint-chromium-staging",
  "fp-download",
  "tmp",
];

const EVENTS = {
  FILE_DELETE: "file.delete",
  FILE_WRITE_SENSITIVE: "file.write.sensitive",
  PROC_SPAWN: "proc.spawn",
  PATH_DENIED: "path.denied",
  NAV_BLOCKED: "nav.blocked",
  INSTALL_DENIED: "install.denied",
  POLICY_BLOCKED: "policy.blocked",
};

/** 内存环形缓冲，供界面快速读取（不必每次读文件） */
const buffer = [];
const BUFFER_MAX = 1000;

/** 相对 storage 根的路径（用于过滤与展示），失败就原样返回 */
function relOf(target) {
  const p = String(target || "");
  if (!p) return "";
  try {
    const rel = path.relative(sp.peek(), p);
    return rel && !rel.startsWith("..") ? rel : p;
  } catch {
    return p;
  }
}

/** 判断这个删除要不要记（见约束③） */
function isQuiet(target) {
  const rel = relOf(target);
  if (!rel || path.isAbsolute(rel)) return false; // storage 之外的一律要记
  const top = rel.split(/[\\/]/)[0];
  return QUIET_PREFIXES.includes(top);
}

/** 滚动：超过上限就改名归档 */
function rotateIfNeeded() {
  try {
    const file = AUDIT_FILE();
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size < MAX_BYTES) return;
    // 最老的先挪走
    const oldest = `${file}.${KEEP_ROTATIONS}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {}
}

/**
 * 记一条审计记录。
 *
 * ⚠️ 永远不要抛异常（约束①）。调用方不需要 try/catch 包着。
 *
 * @param {string} type EVENTS 里的类型
 * @param {object} [detail] 结构化详情，会原样存进 JSON
 */
function log(type, detail = {}) {
  try {
    const entry = {
      time: new Date().toISOString(),
      type: String(type || "unknown"),
      detail,
    };
    buffer.push(entry);
    if (buffer.length > BUFFER_MAX) buffer.shift();
    fs.mkdirSync(path.dirname(AUDIT_FILE()), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(AUDIT_FILE(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 约束①：审计失败绝不打断主流程
  }
}

/**
 * 记录一次删除。程序自管理目录会自动跳过（约束③）。
 * @param {string} target 被删路径
 * @param {{reason?: string, silent?: boolean}} [opts] reason 说明为什么删；silent=true 强制记（无视过滤）
 */
function fileDelete(target, opts = {}) {
  if (!opts.silent && isQuiet(target)) return;
  log(EVENTS.FILE_DELETE, { path: relOf(target), reason: opts.reason || "" });
}

/**
 * 记录一次「越界被拒」。这是审计里最重要的一类 ——
 * 它说明「有东西试图做越界的事」，而不只是「做了什么」。
 * @param {string} what 试图做的事
 * @param {string} target 涉及路径
 * @param {string} reason 拒绝原因
 * @param {string} [source] 来源描述（IPC 通道名等）
 */
function denied(what, target, reason, source = "") {
  log(EVENTS.PATH_DENIED, { what: String(what || ""), path: relOf(target), reason: String(reason || ""), source });
}

/**
 * 记录一次子进程启动。
 * @param {string} cmd 可执行名
 * @param {string[]} [args]
 * @param {string} [why] 场景说明
 */
function procSpawn(cmd, args = [], why = "") {
  log(EVENTS.PROC_SPAWN, {
    cmd: String(cmd || ""),
    args: Array.isArray(args) ? args.map(String).slice(0, 20) : [],
    why: String(why || ""),
  });
}

/**
 * 读取最近的审计记录（新的在前）。
 * @param {number} [limit]
 * @returns {object[]}
 */
function readRecent(limit = 200) {
  const n = Math.min(MAX_READ, Math.max(1, Math.floor(Number(limit) || 200)));
  // 内存里够就用内存的，省一次磁盘读；不够才去读文件补齐
  if (buffer.length >= n) return buffer.slice(-n).reverse();
  try {
    const file = AUDIT_FILE();
    if (!fs.existsSync(file)) return buffer.slice(-n).reverse();
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {}
    }
    return out;
  } catch {
    return buffer.slice(-n).reverse();
  }
}

/** 清空审计记录（含滚动历史） */
function clear() {
  try {
    const file = AUDIT_FILE();
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    for (let i = 1; i <= KEEP_ROTATIONS; i++) {
      const f = `${file}.${i}`;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  } catch {}
  buffer.length = 0;
}

module.exports = {
  EVENTS,
  QUIET_PREFIXES,
  log,
  denied,
  fileDelete,
  procSpawn,
  readRecent,
  clear,
  isQuiet,
  relOf,
};
