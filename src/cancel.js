/**
 * 协作式任务取消（GUI「停止任务」/「停止此账号」按钮）
 *
 * 支持两级中止：
 *   - 全局中止：停止整个批处理/当前所有执行（abort / reset）
 *   - 单账号中止：只停某一个账号，批处理继续跑下一个账号（abortScope）
 *
 * 长任务在每个可中断点调用 throwIfAborted()，sleep 期间也会被立即唤醒。
 * 账号任务串行执行，因此用「当前作用域 activeScope」标识此刻跑的是哪个账号；
 * tasks.js 在模块加载时取走的 sleep 引用，调用时会动态读取 activeScope，
 * 所以无需改动 tasks.js。
 */

let globalAborted = false;
/** 被单独请求中止的账号 id 集合 */
const scopeFlags = new Set();
/** 当前正在执行的账号 id（串行），null 表示账号间等待等非账号阶段 */
let activeScope = null;
/** 正在等待中的 sleep：{ scope, wake } */
const waiters = new Set();

class AbortError extends Error {
  constructor(msg, opts = {}) {
    super(msg || "任务已被用户手动停止");
    this.name = "AbortError";
    this.isAbort = true;
    /** 是否为「停止全部」的全局中止（否则是单账号中止） */
    this.all = !!opts.all;
    /** 触发时的账号作用域 */
    this.scope = opts.scope != null ? opts.scope : activeScope;
  }
}

/** 全局中止：唤醒所有等待中的 sleep（含每个账号） */
function abort() {
  globalAborted = true;
  for (const w of [...waiters]) {
    try {
      w.wake(true);
    } catch {}
  }
  waiters.clear();
}

/** 只中止指定账号：唤醒属于该作用域的 sleep，不影响其它账号与批处理 */
function abortScope(scope) {
  if (scope == null) return;
  scopeFlags.add(scope);
  for (const w of [...waiters]) {
    if (w.scope === scope) {
      try {
        w.wake(false);
      } catch {}
      waiters.delete(w);
    }
  }
}

/** 每次任务/批处理开始前重置全局状态 */
function reset() {
  globalAborted = false;
  scopeFlags.clear();
  activeScope = null;
  for (const w of [...waiters]) {
    try {
      w.wake(true);
    } catch {}
  }
  waiters.clear();
}

/** 清掉某账号的单账号中止标志（新一轮运行该账号前调用） */
function clearScope(scope) {
  if (scope != null) scopeFlags.delete(scope);
}

/** 设置当前执行作用域（runner 在跑某账号前置为其 id，账号间等待置 null） */
function setActiveScope(scope) {
  activeScope = scope != null ? String(scope) : null;
}

function isAborted() {
  return globalAborted || (activeScope != null && scopeFlags.has(activeScope));
}

function isGlobalAborted() {
  return globalAborted;
}

function isScopeAborted(scope) {
  return globalAborted || (scope != null && scopeFlags.has(scope));
}

/** 在可中断点调用；若已请求中止则抛出 AbortError */
function throwIfAborted() {
  if (globalAborted) throw new AbortError("任务已被手动停止", { all: true });
  if (activeScope != null && scopeFlags.has(activeScope)) {
    throw new AbortError("此账号任务已被手动停止", { all: false, scope: activeScope });
  }
}

/**
 * 可被中止的 sleep。
 * - 全局中止或「当前作用域被单账号中止」时立即拒绝 AbortError；
 * - 正常完成则 resolve。
 * @param {number} ms
 */
function sleep(ms) {
  const scope = activeScope;
  if (globalAborted) return Promise.reject(new AbortError("任务已被手动停止", { all: true }));
  if (scope != null && scopeFlags.has(scope)) {
    return Promise.reject(new AbortError("此账号任务已被手动停止", { all: false, scope }));
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const entry = {
      scope,
      wake: (all) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(entry);
        reject(new AbortError(all ? "任务已被手动停止" : "此账号任务已被手动停止", { all, scope }));
      },
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      waiters.delete(entry);
      resolve();
    }, ms);
    waiters.add(entry);
  });
}

module.exports = {
  abort,
  abortScope,
  reset,
  clearScope,
  setActiveScope,
  isAborted,
  isGlobalAborted,
  isScopeAborted,
  throwIfAborted,
  sleep,
  AbortError,
};
