/**
 * 协作式任务取消（GUI「停止任务」按钮）
 *
 * 设计：全局单例的取消标志。长任务在每个可中断点调用 throwIfAborted()，
 * sleep 期间也会被立即唤醒，从而实现"能真正结束当前任务"。
 */

let aborted = false;
const waiters = new Set(); // 正在等待中的 sleep resolver

class AbortError extends Error {
  constructor(msg = "任务已被用户手动停止") {
    super(msg);
    this.name = "AbortError";
    this.isAbort = true;
  }
}

/** 请求中止：唤醒所有等待中的 sleep */
function abort() {
  aborted = true;
  for (const wake of [...waiters]) {
    try {
      wake();
    } catch {}
  }
  waiters.clear();
}

/** 每次任务开始前重置 */
function reset() {
  aborted = false;
  waiters.clear();
}

function isAborted() {
  return aborted;
}

/** 在可中断点调用；若已请求中止则抛出 AbortError */
function throwIfAborted() {
  if (aborted) throw new AbortError();
}

/**
 * 可被中止的 sleep。中止时立即抛出 AbortError，不再等待剩余时间。
 * @param {number} ms
 */
function sleep(ms) {
  if (aborted) return Promise.reject(new AbortError());
  return new Promise((resolve, reject) => {
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(wake);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      waiters.delete(wake);
      resolve();
    }, ms);
    waiters.add(wake);
  });
}

module.exports = { abort, reset, isAborted, throwIfAborted, sleep, AbortError };
