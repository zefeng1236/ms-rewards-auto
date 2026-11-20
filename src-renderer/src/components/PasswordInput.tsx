import { useState } from "react";
import { asciiOnly } from "../utils/asciiInput";

/**
 * 密码输入框：右侧带显隐切换的「小眼睛」。
 *
 * 明文状态显示睁眼（点一下会隐藏），密文状态显示闭眼（点一下会显示），
 * 与常规直觉一致。向导的建库页与安全设置里的重置密码都复用它。
 */
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  /**
   * 「强制英文」：onChange + onCompositionEnd 双保险过滤非 ASCII。
   * 中文输入法合成收尾时浏览器只发 compositionend、未必再发 change，
   * 所以两处都做一次 asciiOnly：拼音字母属 ASCII 会保留，选字后落地的
   * 汉字/全角标点被即时剔除，输入框回退到纯英文。
   */
  return (
    <div className="wz-password-wrap">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(asciiOnly(e.target.value))}
        onCompositionEnd={(e) => onChange(asciiOnly(e.currentTarget.value))}
        placeholder={placeholder}
        autoComplete={autoComplete}
        lang="en"
        spellCheck={false}
      />
      <button
        type="button"
        className="wz-password-eye"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "隐藏密码" : "显示密码"}
        tabIndex={-1}
      >
        {visible ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>
    </div>
  );
}
