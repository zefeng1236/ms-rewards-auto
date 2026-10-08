/**
 * cron 校验的**主进程侧薄壳**（CommonJS）。
 *
 * 为什么要两个文件：真正的解析/求值实现是 `src-renderer/src/utils/cron.ts`
 * （TypeScript，主进程 require 不了 —— Electron 主进程走 CommonJS，不能直接
 * 加载 .ts；而前端那边也没有任何引用 src/ 目录的先例、无 alias，加 alias
 * 反而会动到 vite 配置）。
 *
 * ⛔ **不要在这里重写实现** —— 一旦出现两份解析逻辑，迟早会漂移（而且是那种
 *   只有在某类 cron 表达式上才暴露的漂移，极难发现）。
 *   本文件**只做结构校验**（判断「像不像合法 cron」），语义一律以 .ts 为准；
 *   渲染层的 `describeCron` 才是用户看到的权威校验与报错来源。
 *
 * 校验规则刻意**保守**（宁可放过、让前端报错，也别在主进程误杀合法表达式）：
 *   - 必须正好 5 段（分 时 日 月 周）
 *   - 每段只能出现「数字、星号、斜杠、逗号、连字符」这些字符，且不能为空
 *   - 数字不越界（分 0-59、时 0-23、日 1-31、月 1-12、周 0-7）
 * 但**不**在这里做区间/步长的完整语义校验（如倒序区间 `10-1`、步长为 0），
 * 那些交给前端 describeCron，主进程不拦。
 *
 * ⚠️ 本注释故意不直接写「星号紧跟斜杠」的连续字符 —— 那是块注释的结束符，
 *    写在注释里会让整个文件语法错误（本项目已踩两次，见 cron.ts 里的同类备注）。
 */

const FIELD_RANGE = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周
];

/**
 * 判断字符串是否是「结构上可能合法」的 cron 表达式。
 *
 * ⚠️ 这**不是**完整校验（`10-1 * * * *` 会被判为结构合法），
 *    只用于「保存前拦掉明显笔误」，精确语义判断请用前端的 describeCron。
 *
 * @param {string} expr
 * @returns {boolean}
 */
function isCronShallowValid(expr) {
  const s = String(expr == null ? "" : expr).trim();
  if (!s) return false;
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    const p = parts[i];
    if (!p) return false;
    if (!/^[0-9*/,-]+$/.test(p)) return false; // 只允许这几种字符
    const [lo, hi] = FIELD_RANGE[i];
    // 逐个核对出现在该段的数字是否越界（步长 /n 不参与范围校验）
    const nums = p.replace(/\/[^/]*/g, "").match(/\d+/g) || [];
    for (const n of nums) {
      const v = Number(n);
      if (v < lo || v > hi) return false;
    }
  }
  return true;
}

module.exports = { isCronShallowValid };