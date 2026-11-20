/**
 * 密码/密钥输入框的「强制英文」处理（2026-11-20 用户提：输密码时被中文输入法坑过）。
 *
 * 背景：Web/Electron 层没法真正切换系统输入法（那要动 OS IME，浏览器沙箱里做不到）。
 * 但密码、恢复密钥、口令这类内容本来就是 ASCII —— 中文输入法打出来的汉字、
 * 全角标点（如「ＡＢＣ１２３」，U+FF01–U+FF5E）一律不是合法密码字符。
 * 所以在 onChange / onCompositionEnd 处把非 ASCII 直接剔除，效果等同「强制英文」：
 *   - 英文输入法下敲 ASCII：原样保留；
 *   - 中文输入法拼字：中途的拼音字母会被 IME 合成事件覆盖，最终汉字被过滤掉；
 *   - 全角字符：统一丢弃（不转半角，避免用户以为输对了其实变了内容）。
 *
 * 只用于「密码 / 恢复密钥」这类确定只含 ASCII 的字段。API Key、备注、密码提示
 * 等可能含非 ASCII 的字段**不要**用它，否则会误删用户输入。
 */

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

/** 只保留 ASCII 可打印字符（空格到 ~），其余（中文/全角/emoji）全部剔除 */
export function asciiOnly(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += ch;
  }
  return out;
}

/** 值是否已是纯 ASCII（守卫/测试用） */
export function isAscii(value: string): boolean {
  return ASCII_PRINTABLE.test(value);
}

/**
 * 给原生 <input> 用的 onChange 清洗：把 event.target.value 过滤后交给回调。
 * 用一个受控的再次赋值保证 DOM 与 state 同步（剔除中文后输入框立刻回退）。
 */
export function cleanAsciiChange(
  value: string,
  commit: (cleaned: string) => void
): void {
  const cleaned = asciiOnly(value);
  if (cleaned !== value) commit(cleaned);
  else commit(value);
}
