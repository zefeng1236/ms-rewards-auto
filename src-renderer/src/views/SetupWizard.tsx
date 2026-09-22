import { useEffect, useMemo, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { toast } from "../components/liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { saveRecoveryKeyToBrowser } from "../api/web";
import { PasswordInput } from "../components/PasswordInput";
import { evaluatePassword, STRENGTH_COLORS } from "../utils/passwordStrength";
import type { SetupState } from "../types";

/** 恢复密钥 txt 的内容（含使用说明，避免用户只存到一串字符不知用途） */
function buildRecoveryText(key: string): string {
  return [
    "Microsoft Rewards 自动化工具 - 恢复密钥",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    key,
    "",
    "说明：",
    "- 这是忘记加密密码时唯一的解锁方式。",
    "- 密码本身不会被保存在任何地方，密钥丢失将无法恢复数据。",
    "- 请妥善离线保存，不要与密码存放在同一处。",
  ].join("\n");
}

/**
 * 首次启动向导。
 *
 * 只在用户第一次打开软件时出现（setup.json 的 done 为 false 时），走完五步后
 * 写入 done=true，之后不再弹出。五页依次是：
 *   1. 欢迎 + 选择语言（当前仅简体中文可用，其余语种标注「暂未开发」）
 *   2. 隐私政策 / 服务条款 / 免责声明（多文档切换 + 必须勾选同意）
 *   3. 非官方授权声明与使用风险告知（3 秒倒计时后才能确认）
 *   4. 加密保险库（设置密码；启用后登录态只以密文落盘，并下发恢复密钥）
 *   5. 个性化初始设置（液态玻璃、开机自启）
 */

const STEPS = ["欢迎", "协议", "声明", "加密", "个性化"];

/** 语言选项。ready=false 的只做占位展示，标注用该语言自己写的「暂未开发」 */
const LANGS: { key: string; name: string; sub: string; ready: boolean; tip: string }[] = [
  { key: "zh-CN", name: "简体中文", sub: "Simplified Chinese", ready: true, tip: "" },
  { key: "zh-TW", name: "繁體中文", sub: "Traditional Chinese", ready: false, tip: "暫未開發" },
  { key: "en", name: "English", sub: "English", ready: false, tip: "Coming soon" },
  { key: "ru", name: "Русский", sub: "Russian", ready: false, tip: "В разработке" },
  { key: "ja", name: "日本語", sub: "Japanese", ready: false, tip: "未実装" },
];

type DocKey = "privacy" | "terms" | "disclaimer";

/** 第二页的三份文档。## 开头的行渲染成小标题 */
const DOCS: { key: DocKey; label: string }[] = [
  { key: "privacy", label: "隐私政策" },
  { key: "terms", label: "服务条款" },
  { key: "disclaimer", label: "免责声明" },
];

const DOC_TEXT: Record<DocKey, string[]> = {
  privacy: [
    "## 一、我们收集什么",
    "本软件是一款运行在您本机电脑上的桌面工具。您的 Microsoft 账户登录态（Cookie）、积分数据、推送通道地址等敏感信息，一律保存在您本机的数据目录中，不会上传到任何由本软件维护的服务器——因为本软件根本没有服务器。",
    "## 二、我们如何使用这些信息",
    "登录态仅用于在您主动触发时，代替您访问 Microsoft Rewards 页面完成签入、阅读、搜索等任务；推送通道地址仅用于在任务结束后把结果发送到您自己填写的企业微信 / 钉钉 / 飞书 / Bark 等地址。除此以外不会用于任何其他用途。",
    "## 三、信息的存储与删除",
    "所有数据以明文 JSON 与浏览器配置文件的形式存放在本机应用数据目录。您随时可以在软件内删除账户，或卸载软件并手动删除数据目录来彻底清除。卸载软件不会自动删除数据目录，如需彻底清理请自行删除。",
    "## 四、第三方服务",
    "本软件会访问 Microsoft 的官方服务（必应搜索、Rewards 页面等），这些访问受微软自身隐私政策约束。若您启用了推送通知，运行汇总会发送到您配置的地址，该过程由对应的第三方服务商处理。若您使用在线壁纸图源，会向该图源发起图片请求。",
    "## 五、日志",
    "软件会在本机记录运行日志，用于排查任务失败原因。日志中的推送地址等敏感字段会做脱敏处理，但请注意日志仍可能包含账户名称等信息，分享日志前请先自行检查。",
    "## 六、儿童隐私",
    "本软件面向具备完全民事行为能力的成年人，不面向未成年人提供服务。",
    "## 七、政策更新",
    "本政策可能随版本更新而调整，更新后的版本会随软件一同分发。继续使用即视为接受更新后的内容。",
  ],
  terms: [
    "## 一、服务说明",
    "本软件为开源的个人效率工具，以「现状」提供，不保证功能永不中断、不出错或永远兼容。Microsoft Rewards 的页面结构、接口与风控策略随时可能变化，由此导致的任务失败本软件不承担责任。",
    "## 二、用户义务",
    "您承诺仅将本软件用于您本人拥有合法权益的账户，且遵守 Microsoft 服务协议以及您所在国家或地区的法律法规。您不得将本软件用于批量注册、刷量、牟利、转售或任何侵犯他人权益的行为。",
    "## 三、账号与登录",
    "您需要自行通过软件内的登录流程授权账户。请妥善保管本机数据安全，本软件无法为您找回丢失或被盗的登录态。若怀疑账户异常，请立即在软件内删除该账户并修改密码。",
    "## 四、可接受使用限制",
    "禁止对软件进行反向工程后用于商业分发、禁止去除版权与开源声明、禁止利用本软件对 Microsoft 服务发起超出正常频次的大量请求。合理设置运行频率是每个用户应尽的责任。",
    "## 五、开源许可",
    "本软件基于 MIT 许可开源，您可以自由使用、复制、修改与分发，但需保留版权与许可声明。软件按「现状」提供，作者不对任何直接或间接损失承担责任。",
    "## 六、服务变更与终止",
    "作者可能因技术、法律或其他原因停止维护本软件。您也可以随时停止使用并卸载。",
    "## 七、争议解决",
    "本条款适用中华人民共和国法律。如发生争议，应友好协商解决。",
  ],
  disclaimer: [
    "## 一、非官方声明",
    "本软件是个人开发者出于学习与技术交流目的编写的开源工具，与 Microsoft Corporation 没有任何隶属、代理、授权或合作关系。软件中出现的 Microsoft、Bing、Microsoft Rewards 等名称与商标归其各自权利人所有，仅作描述性指代之用。",
    "## 二、使用风险",
    "使用本软件可能违反 Microsoft 服务协议中关于自动化访问的相关条款，由此可能产生账户受限、积分回收、功能禁用等后果，相关风险与损失由您自行承担。",
    "## 三、无担保",
    "软件按「现状」提供，不提供任何明示或暗示的担保，包括但不限于适销性、特定用途适用性以及不侵权的担保。作者不保证软件无缺陷、不间断或不丢失数据。",
    "## 四、责任限制",
    "在任何情况下，作者均不对因使用或无法使用本软件所导致的任何直接、间接、偶然、特殊或后果性损失承担责任，包括但不限于积分损失、账户损失、数据丢失、利润损失或业务中断。",
    "## 五、合规提醒",
    "请在使用前确认您所在地区的法律法规以及 Microsoft 服务协议允许此类自动化行为。若您所在环境不允许，请立即停止使用并卸载本软件。",
  ],
};

/** 第三页：使用本软件可能造成的后果 */
const RISKS: string[] = [
  "账户被风控识别为自动化行为，导致签入、搜索或兑换功能被限制，甚至账户被封禁且无法申诉恢复。",
  "已获得的积分被扣减、冻结或清零，已兑换的奖励被撤回或要求补款。",
  "触发人机验证（验证码、短信验证、设备验证），导致您本人也无法正常登录。",
  "因请求频率过高，导致您的网络出口 IP 被临时或长期限制访问相关服务。",
  "由于您自行配置的推送地址填写错误，运行汇总被发送到错误的接收方，造成信息泄露。",
  "软件缺陷、系统环境差异或异常断电导致任务中断、数据写入不完整或本地记录丢失。",
  "因违反 Microsoft 服务协议或当地法律法规而产生的法律责任，需由您自行承担。",
  "长期后台运行带来的额外电量、流量与硬件资源消耗。",
];

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    api.getSetup().then(setState).catch(() => setState(null));
  }, []);

  if (!state) return null;

  /** 统一走 setSetup：主进程会顺带把液态玻璃/开机自启落到对应子系统 */
  const patch = async (p: Partial<SetupState>) => {
    const next = await api.setSetup(p);
    setState(next);
  };

  const finish = async () => {
    await patch({ done: true, agreed: true, lang: state.lang });
    onDone();
  };

  return (
    <div className="wizard">
      <div className="wizard-card">
        <header className="wizard-head">
          <img className="wizard-logo" src="./icon.png" alt="" />
          <div className="wizard-steps">
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={`wizard-step${i === page ? " on" : ""}${i < page ? " ok" : ""}`}
              >
                <span className="wizard-dot">{i < page ? "✓" : i + 1}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </header>

        <div className="wizard-body">
          {page === 0 && <PageWelcome lang={state.lang} onLang={(v) => void patch({ lang: v })} />}
          {page === 1 && (
            <PageDocs
              agreed={state.agreed}
              onAgree={(v) => void patch({ agreed: v })}
            />
          )}
          {page === 2 && <PageNotice />}
          {page === 3 && <PageVault onNext={() => setPage(4)} />}
          {page === 4 && (
            <PagePersonalize
              liquidGlass={state.liquidGlass}
              autoLaunch={state.autoLaunch}
              onChange={(p) => void patch(p)}
            />
          )}
        </div>

        <footer className="wizard-foot">
          <GlassButton variant="glass" controlSize="small"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← 上一步
          </GlassButton>

          <span className="wizard-progress">
            {page + 1} / {STEPS.length}
          </span>

          {page < 2 && (
            <GlassButton variant="glassProminent" controlSize="small"
              onClick={() => setPage((p) => p + 1)}
              disabled={page === 1 && !state.agreed}
            >
              下一步 →
            </GlassButton>
          )}
          {page === 2 && <CountdownNext onNext={() => setPage(3)} />}
          {/* 加密页自带操作按钮（要先把恢复密钥展示完才能进下一步），
              这里只放提示，避免页脚按钮与页内流程状态不同步 */}
          {page === 3 && <span className="wizard-note">请在上方完成加密设置</span>}
          {page === 4 && (
            <GlassButton variant="glassProminent" controlSize="small" onClick={finish}>
              开始使用 ✓
            </GlassButton>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ---------------- 第 1 页：欢迎 + 语言 ---------------- */

function PageWelcome({ lang, onLang }: { lang: string; onLang: (v: string) => void }) {
  return (
    <div className="wz-page wz-welcome">
      <h2>欢迎使用 Microsoft Rewards Auto</h2>
      <p className="wz-lead">
        一款运行在你自己电脑上的微软积分自动任务工具：多账户隔离、任务进度可视、
        运行汇总推送。接下来几步会帮你完成必要的初始设置。
      </p>

      <div className="wz-sub">选择界面语言</div>
      <div className="wz-langs">
        {LANGS.map((l) => {
          const active = lang === l.key;
          return (
            <button
              key={l.key}
              type="button"
              className={`wz-lang${active ? " on" : ""}${l.ready ? "" : " off"}`}
              disabled={!l.ready}
              onClick={() => l.ready && onLang(l.key)}
              title={l.ready ? `切换到${l.name}` : `${l.name}：${l.tip}`}
            >
              <span className="wz-lang-main">
                <span className="wz-radio" data-on={active ? "1" : "0"} />
                <span className="wz-lang-name">{l.name}</span>
                {active && <span className="wz-badge">默认</span>}
                {!l.ready && <span className="wz-badge gray">{l.tip}</span>}
              </span>
              <span className="wz-lang-sub">{l.sub}</span>
            </button>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        当前版本仅提供简体中文，其余语种正在开发中，暂不可切换。
      </p>
    </div>
  );
}

/* ---------------- 第 2 页：协议文档 ---------------- */

function PageDocs({
  agreed,
  onAgree,
}: {
  agreed: boolean;
  onAgree: (v: boolean) => void;
}) {
  const [doc, setDoc] = useState<DocKey>("privacy");
  const lines = useMemo(() => DOC_TEXT[doc], [doc]);

  return (
    <div className="wz-page wz-docs">
      <div className="wz-doc-tabs">
        {DOCS.map((d) => (
          <button
            key={d.key}
            type="button"
            className={`wz-doc-tab${doc === d.key ? " on" : ""}`}
            onClick={() => setDoc(d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="wz-doc-body">
        {lines.map((line, i) =>
          line.startsWith("## ") ? (
            <h4 key={i}>{line.slice(3)}</h4>
          ) : (
            <p key={i}>{line}</p>
          )
        )}
        <p className="wz-doc-end">—— 以上为《{DOCS.find((d) => d.key === doc)?.label}》全部内容 ——</p>
      </div>

      <button
        type="button"
        className={`wz-check${agreed ? " on" : ""}`}
        onClick={() => onAgree(!agreed)}
      >
        <span className="wz-check-box">{agreed ? "✓" : ""}</span>
        <span>
          我已阅读并同意《隐私政策》《服务条款》与《免责声明》
        </span>
      </button>
      {!agreed && <div className="hint">请先勾选同意，才能进入下一步</div>}
    </div>
  );
}

/* ---------------- 第 3 页：非官方声明 + 倒计时 ---------------- */

function PageNotice() {
  return (
    <div className="wz-page wz-notice">
      <div className="wz-alert">
        <strong>本软件非微软官方授权产品</strong>
        <span>仅供个人学习和交流使用，与 Microsoft Corporation 无任何关联</span>
      </div>

      <p className="wz-lead">
        在使用前，请你务必了解并确认：使用本软件可能带来以下后果，且需由你自行承担。
      </p>

      <ol className="wz-risks">
        {RISKS.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ol>

      <p className="wz-lead">
        如果你无法接受上述任何一项风险，请立即退出并卸载本软件。继续操作即表示你已充分理解并自愿承担全部风险。
      </p>
    </div>
  );
}

function CountdownNext({ onNext }: { onNext: () => void }) {
  const [left, setLeft] = useState(3);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  return (
    <GlassButton variant="glassProminent" controlSize="small" disabled={left > 0} onClick={onNext}>
      {left > 0 ? `请仔细阅读（${left}s）` : "我已了解并确认 →"}
    </GlassButton>
  );
}

/* ---------------- 第 4 页：加密保险库 ---------------- */

/**
 * 设置加密密码。
 *
 * 两个必须讲清楚的点都写在页面上了：
 *   1. 日常启动不需要重复输密码（系统钥匙串自动解锁）；
 *   2. 密码本身不落盘，忘密码只能靠恢复密钥 —— 所以建库后必须先展示并让用户确认保存。
 */
function PageVault({ onNext }: { onNext: () => void }) {
  const [enable, setEnable] = useState(true);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [recovery, setRecovery] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  // 关掉「启用加密」时的风险确认弹窗
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [countdown, setCountdown] = useState(5);
  // 升级老用户防御：保险库已配置时（覆盖安装、setup.json 缺失等场景），
  // 本页不能显示创建表单 —— vaultSetup 会报「保险库已配置，请勿重复设置」。
  // null=查询中，true=已配置（渲染「已就绪」分支），false=未配置（正常表单）。
  const [vaultCfg, setVaultCfg] = useState<boolean | null>(null);

  // ⚠ 下面这段 Hook 与 st 必须写在 `if (recovery)` 之前。
  // 提前 return 会让「已生成恢复密钥」的那一次渲染少调用一个 Hook，
  // React 会判定 Hook 数量不一致并直接卸载整棵树 —— 表现为建库成功后白屏。
  // 「确定取消」按钮的 5 秒倒计时：倒数结束前不允许确认关闭加密
  useEffect(() => {
    if (!confirmDisable) return;
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [confirmDisable, countdown]);

  // 实时强度评估（仅用于界面提示，不参与加密）
  const st = evaluatePassword(pw);

  // 查询保险库状态（Hook 必须在所有 early return 之前调用，原因同上）
  useEffect(() => {
    let alive = true;
    api
      .getVaultStatus()
      .then((v) => {
        if (alive) setVaultCfg(!!v.configured);
      })
      .catch(() => {
        if (alive) setVaultCfg(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 建库成功后先钉住用户把恢复密钥抄走，再放行下一步
  if (recovery) {
    return (
      <div className="wz-page wz-vault">
        <h2>请妥善保存你的恢复密钥</h2>
        <p className="wz-lead">
          这是忘记密码时<strong>唯一</strong>的解锁方式。密码本身不会被保存在任何地方，
          我们无法为你找回。请把下面这串密钥抄下来，存进密码管理器或离线保存。
        </p>
        <div className="wz-recovery">
          <code>{recovery}</code>
          <button
            type="button"
            className="wz-copy"
            onClick={() => void navigator.clipboard?.writeText(recovery)}
          >
            复制
          </button>
        </div>
        <div className="wz-recovery-act">
          <button
            type="button"
            className="wz-dl"
            onClick={async () => {
              setSavingKey(true);
              const r = await api.saveTextFile(
                buildRecoveryText(recovery),
                `ms-rewards-recovery-key-${new Date().toISOString().slice(0, 10)}`
              );
              setSavingKey(false);
              if (r.canceled) return;
              if (!r.ok) toast.error(r.error || "保存失败");
              else toast.success(`已保存到 ${r.path}`);
            }}
            disabled={savingKey}
          >
            {savingKey ? "保存中…" : "下载为 txt"}
          </button>
          {/* Web 版专属：把恢复密钥存进浏览器，下次打开就能一键登录 */}
          {IS_WEB && (
            <button
              type="button"
              className="wz-dl"
              onClick={() => {
                saveRecoveryKeyToBrowser(recovery);
                toast.success("已保存到本机浏览器，下次可直接点「一键登录」");
              }}
            >
              🔑 存到本机浏览器
            </button>
          )}
          <span className="hint">建议离线保存或存入密码管理器</span>
        </div>
        {IS_WEB && (
          <p className="wz-lead" style={{ marginTop: 8 }}>
            「存到本机浏览器」只写入这台设备的浏览器本地存储，方便你下次一键登录；
            换设备或清空浏览器数据后需用 txt 里的密钥。
          </p>
        )}
        <button
          type="button"
          className={`wz-check${saved ? " on" : ""}`}
          onClick={() => setSaved(!saved)}
        >
          <span className="wz-check-box">{saved ? "✓" : ""}</span>
          <span>我已把恢复密钥保存到安全的地方</span>
        </button>
        {!saved && <div className="hint">请先确认已保存，再进入下一步</div>}
        <div className="wz-next">
          <GlassButton variant="glassProminent" controlSize="small" disabled={!saved} onClick={onNext}>
            下一步 →
          </GlassButton>
        </div>
      </div>
    );
  }

  // 保险库已配置（升级覆盖安装等场景）：不再显示创建表单，直接放行。
  // 主进程的 setup:get 迁移 normally 会让向导根本不弹，这里是渲染端兜底，
  // 两层都挡住才能保证老用户永远不会看到「保险库已配置，请勿重复设置」。
  if (vaultCfg) {
    return (
      <div className="wz-page wz-vault">
        <h2>加密保险库已就绪</h2>
        <p className="wz-lead">
          检测到本机已配置加密保险库，<strong>无需重复设置</strong>。
          你的登录态继续以密文保存；日常启动由系统钥匙串自动解锁，不需要每次输密码。
        </p>
        <div className="wz-alert">
          <strong>忘记密码？</strong>
          <span>完成后可在「全局设置 → 安全」里查看密码提示，或用恢复密钥解锁。</span>
        </div>
        <div className="wz-next">
          <GlassButton variant="glassProminent" controlSize="small" onClick={onNext}>
            下一步 →
          </GlassButton>
        </div>
      </div>
    );
  }

  const submit = async () => {
    // 状态查询已确认「已配置」时（或尚未返回、处于未知态）不再尝试建库，
    // 避免和主进程的「保险库已配置」报错撞车
    if (vaultCfg !== false) {
      onNext();
      return;
    }
    if (!enable) {
      onNext();
      return;
    }
    setErr("");
    if (!st.complex) {
      setErr(`密码不符合要求：${st.missing.join("、")}`);
      return;
    }
    if (st.level < 3) {
      setErr("密码强度不足，请达到强度条的第 3 段");
      return;
    }
    if (pw !== pw2) {
      setErr("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    let r: Awaited<ReturnType<typeof api.vaultSetup>> | undefined;
    try {
      r = await api.vaultSetup(pw, hint);
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || "设置失败，请重试");
      return;
    }
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || "设置失败，请重试");
      return;
    }
    setRecovery(r.recoveryKey || "");
  };

  return (
    <div className="wz-page wz-vault">
      <h2>加密你的账户登录态</h2>
      <p className="wz-lead">
        启用后，微软登录 Cookie 与令牌会用<strong>只有你才知道</strong>的密码加密后再存到本机，
        磁盘上不再留明文。
        {IS_WEB
          ? "下一步把恢复密钥存到本机浏览器，之后打开网页点一下就登录，不用每次输密码。"
          : "日常启动由系统钥匙串自动解锁，不需要每次输密码。"}
      </p>

      <button type="button" className={`wz-opt${enable ? " on" : ""}`} onClick={() => setEnable(true)} data-testid="opt-enable">
        <span className="wz-opt-main">
          <strong>启用加密（推荐）</strong>
          <span className="wz-switch" data-on={enable ? "1" : "0"}>
            <span className="wz-knob" />
          </span>
        </span>
        <span className="wz-opt-sub">
          {IS_WEB
            ? "设置一个密码作为加密密钥。把恢复密钥存到本机浏览器后，打开网页点一下即可登录。"
            : "设置一个密码作为加密密钥。之后每次打开软件会自动解锁，无需重复输入。"}
        </span>
      </button>

      <button
        type="button"
        className={`wz-opt${!enable ? " on" : ""}`}
        data-testid="opt-disable"
        onClick={() => {
          // 只有从「启用」切到「不启用」才需要风险确认；已经是关闭态则无需重复提示
          if (enable) {
            setCountdown(5);
            setConfirmDisable(true);
          }
        }}
      >
        <span className="wz-opt-main">
          <strong>暂不启用</strong>
          <span className="wz-switch" data-on={!enable ? "1" : "0"}>
            <span className="wz-knob" />
          </span>
        </span>
        <span className="wz-opt-sub">
          登录态以明文存在本机数据目录。电脑被他人使用、或数据目录被拷贝时存在泄露风险。
          以后仍可在「全局设置 → 安全」里开启。
        </span>
      </button>

      {enable && (
        <div className="wz-fields">
          <label className="wz-field">
            <span>加密密码</span>
            <PasswordInput
              value={pw}
              onChange={setPw}
              placeholder="至少 8 位，含大小写字母、数字和特殊字符"
              autoComplete="new-password"
            />
          </label>

          {/* 五段分色强度条：达到第 3 段才算符合密码要求 */}
          {pw && (
            <div className="wz-pw-meter">
              <div className="wz-pw-bars">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="wz-pw-bar"
                    style={{
                      background:
                        i < st.level ? STRENGTH_COLORS[Math.min(st.level - 1, 4)] : "rgba(255,255,255,.12)",
                    }}
                  />
                ))}
              </div>
              <span className="wz-pw-label" style={{ color: st.level >= 3 ? STRENGTH_COLORS[4] : STRENGTH_COLORS[0] }}>
                {st.label}
                {st.pass ? "（符合要求）" : "（需达到第 3 段）"}
              </span>
            </div>
          )}

          {/* 复杂度未满足时列出缺什么 */}
          {pw && !st.complex && (
            <div className="wz-pw-missing">
              还需包含：{st.missing.join("、")}
            </div>
          )}

          {/* 弱模式只提醒、不禁止 */}
          {pw && st.weakHints.length > 0 && (
            <div className="wz-pw-weak">
              {st.weakHints.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
            </div>
          )}

          <label className="wz-field">
            <span>确认密码</span>
            <PasswordInput
              value={pw2}
              onChange={setPw2}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </label>
          <label className="wz-field">
            <span>密码提示（可选，明文保存）</span>
            <input
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="给自己留一个提示（明文保存）"
            />
          </label>
        </div>
      )}

      {/* 关闭加密前的风险确认：默认引导用户启用密码 */}
      {confirmDisable && (
        <div className="wz-modal-mask" role="dialog" aria-modal="true" aria-label="关闭加密的风险提示">
          <div className="wz-modal">
            <h3>确定不设置密码吗？</h3>
            <p className="wz-modal-lead">
              关闭后，微软登录 Cookie 与令牌将以<strong>明文</strong>存放在本机数据目录。
              一旦电脑被他人使用、或数据目录被拷贝/同步，登录态就会<strong>直接泄露</strong>。
            </p>
            <p className="wz-modal-sug">
              建议保持启用：设置一个密码后，日常启动由系统钥匙串自动解锁，不需要每次输入。
            </p>
            <div className="wz-modal-act">
              <button
                type="button"
                className="wz-btn-danger"
                disabled={countdown > 0}
                onClick={() => {
                  setEnable(false);
                  setConfirmDisable(false);
                }}
              >
                确定取消{countdown > 0 ? `（${countdown}s）` : ""}
              </button>
              <button
                type="button"
                className="wz-btn-primary"
                onClick={() => {
                  setEnable(true);
                  setConfirmDisable(false);
                }}
              >
                启用密码
              </button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="wz-err">{err}</div>}

      <div className="wz-alert">
        <strong>密码不可找回</strong>
        <span>密码本身不会被保存，忘记后只能用恢复密钥解锁。下一步会生成并展示这把密钥。</span>
      </div>

      <div className="wz-next">
        <GlassButton variant="glassProminent" controlSize="small" loading={busy} onClick={submit}>
          {enable ? "创建加密保险库 →" : "跳过，暂不加密 →"}
        </GlassButton>
      </div>
    </div>
  );
}

/* ---------------- 第 5 页：个性化初始设置 ---------------- */

function PagePersonalize({
  liquidGlass,
  autoLaunch,
  onChange,
}: {
  liquidGlass: boolean;
  autoLaunch: boolean;
  onChange: (p: Partial<SetupState>) => void;
}) {
  return (
    <div className="wz-page wz-init">
      <h2>个性化初始设置</h2>
      <p className="wz-lead">下面两项随时可以在「个性化」和「启动与托盘」页面里再改。</p>

      <button
        type="button"
        className={`wz-opt${liquidGlass ? " on" : ""}`}
        onClick={() => onChange({ liquidGlass: !liquidGlass })}
      >
        <span className="wz-opt-main">
          <strong>启用液态玻璃效果</strong>
          <span className="wz-switch" data-on={liquidGlass ? "1" : "0"}>
            <span className="wz-knob" />
          </span>
        </span>
        <span className="wz-opt-sub">
          界面采用毛玻璃质感与光影折射。观感更好，但会占用更多显卡资源；老机器或追求性能可关闭，
          关闭后自动切换为扁平样式。
        </span>
      </button>

      {/* 开机自启是桌面端语义：Docker 版由 compose 的 restart 策略负责，隐藏掉避免误导 */}
      {!IS_WEB && (
        <button
          type="button"
          className={`wz-opt${autoLaunch ? " on" : ""}`}
          onClick={() => onChange({ autoLaunch: !autoLaunch })}
        >
          <span className="wz-opt-main">
            <strong>开机自动启动</strong>
            <span className="wz-switch" data-on={autoLaunch ? "1" : "0"}>
              <span className="wz-knob" />
            </span>
          </span>
          <span className="wz-opt-sub">
            把本软件注册到系统登录项，开机后自动运行（默认最小化到托盘，不打扰你）。
            若你只是偶尔用一次，建议关闭。
          </span>
        </button>
      )}
    </div>
  );
}
