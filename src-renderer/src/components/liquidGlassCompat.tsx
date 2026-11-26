/**
 * 液态玻璃组件库补位层。
 *
 * 背景：上游 `@ttqtt/liquid-glass-react` 0.0.2（重写版）只提供玻璃/控件层组件，
 * 没有 Input / Select / InputNumber / Table / Tag / Empty / Modal / SideNav /
 * ProgressiveBlur / Toaster / useAmbientFromImage / createTheme 这些内容层与
 * 应用级组件；项目内容卡片则基于新版 MaterialView（不是实色 Card）。本文件为缺口提供实现，命名尽量与旧版保持一致，
 * 业务代码无需关心它们的来源。
 *
 * 已下沉到上游原生的组件（不再经过本文件）：
 *   Button → GlassButton（variant/controlSize/loading 均为上游 props）
 *   Switch → GlassSwitch
 *   Slider → GlassSlider（提交语义由 components/CommitSlider.tsx 补）
 *   Segmented → GlassSegmentedControl
 *   实色 Card → 项目 AppCard（基于新版 MaterialView；壁纸贯穿页面需内容层半透明材质）
 *   GlassSurface → GlassSurface
 *   Provider → GlassProvider
 *
 * ⚠️ 以下组件经 2026-09-19 评估后**明确不上游化**——上游要么没有对应能力，要么语义层级不同，
 * 强行替换会造成实质退化。逐条理由在下面，想动它们之前先读完：
 *   Tag      → GlassBadge：本项目 Tag 是**文本状态标签**，有 accent/success/warning/danger/
 *              default 五种语义色（15 处）；GlassBadge 是**数字徽标**，只有 notification/
 *              neutral/accent 三种 tone，没有 danger/success/warning → 换掉会丢状态语义色。
 *   toast    → useToast：本项目是 imperative 调用（50 处，含 async 回调与工具函数等**非组件
 *              上下文**），且有 success/error/info 三态样式；useToast 是 hook、message 为
 *              string、**没有三态语义**。
 *   Input    → TextField：TextField 的 label **必填**且渲染可见 <label>。本项目 9 处 Input
 *              全是无 label 的内联控件（表格行内、搜索框、placeholder 即 label、周边已有标题），
 *              换上会给每个输入框塞一个可见 label，版面显著变差。带 label 的表单字段走
 *              components/fields.tsx 的 TextField 包装——分层本来就是对的。
 *   Table    → List/ListRow：本项目表格是**多列对齐**（账号/状态/进度/操作，含 column.render
 *              与复杂 emptyText）；List/ListRow 是「标签+副标签+值+附件」的行结构，表达不了列。
 *   Modal    → GlassDialog：GlassDialog 的 title/description 均**必填 string** 且**没有 footer**；
 *              本项目 5 处 Modal 全部依赖 footer（含 checkbox、flex spacer 等非按钮内容）、
 *              有 sm/md/lg 三档 size、有 closeOnOverlayClick。**已改为内部用 native <dialog>**
 *              拿到焦点 containment / top layer / Escape（2026-09-19 修复，见 ModalBase），
 *              对外 API 不变——收益已经拿到，再换成 GlassDialog 只会丢 footer 与 size。
 *   SideNav  → Sidebar：新库 Sidebar 是**侧边栏容器**（header/footer/children + aria-label），
 *              不含 items/value/onChange 的导航语义；本项目 SideNav 是导航列表，层级不同，
 *              不是替代关系。
 *   Select / InputNumber / Empty / ProgressiveBlur / useAmbientFromImage / createTheme /
 *   Toaster / LiquidGlassConfig：上游**没有对应导出**，只能自建。
 *
 * ⚠️ 补位 CSS 的变量必须用项目真实变量名（global.css 里定义的 --panel / --border /
 *   --lg-success / --lg-warning…）。曾因沿用**旧库 0.2.0 的变量名**（--panel-solid / --line /
 *   --success / --warning）导致 Select/Table/Modal/Toast 共 10 条声明整条静默失效
 *   （var() 引用未定义变量且无 fallback → 属性保持初始值）。加样式后请跑一遍
 *   "CSS 变量体检"（见 .workbuddy/memory 里的排查脚本）。
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  GlassButton,
  GlassProvider,
  MaterialView,
  type MaterialViewProps,
} from "@ttqtt/liquid-glass-react";
import { CloseButton, CloseGlyph } from "./CloseButton";
import "./liquidGlassCompat.css";

export type LegacySize = "sm" | "md" | "lg";

function joinClass(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// 表单控件（上游无对应：Input / InputNumber / Select）
// ---------------------------------------------------------------------------

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: LegacySize;
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
}

/**
 * style / className 落在**外壳**上（与旧库一致）：项目里的调用都是按旧库语义写的
 * （`style={{ width: 90 }}`、`{ minWidth: 280, flex: 1 }` 这类都是容器的排版意图）。
 * 若把 style 落到内层 <input>，外壳仍是 `inline-flex` 且被 flex 容器压缩 ——
 * 「自动轮换」那种输入框就会变成又窄又高，和原来的尺寸对不上。
 */
export function Input({ size = "md", prefix, suffix, invalid, className, style, ...props }: InputProps) {
  return (
    <span
      className={joinClass("compat-input-wrap", `compat-${size}`, invalid && "is-invalid", className)}
      style={style}
    >
      {prefix && <span className="compat-input-affix">{prefix}</span>}
      <input {...props} className="compat-input" aria-invalid={invalid || undefined} />
      {suffix && <span className="compat-input-affix">{suffix}</span>}
    </span>
  );
}

export interface InputNumberProps {
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  placeholder?: string;
  size?: LegacySize;
  disabled?: boolean;
  /** 输入框内的单位后缀（如「分」「天」）。只显示裸数字时用户看不出单位。 */
  suffix?: ReactNode;
  "aria-label"?: string;
}

export function InputNumber({ value, defaultValue, onChange, precision, ...props }: InputNumberProps) {
  const normalize = (raw: string): number | null => {
    if (raw === "") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return typeof precision === "number" ? Number(parsed.toFixed(precision)) : parsed;
  };
  const initial = value ?? defaultValue;
  const [draft, setDraft] = useState(initial == null ? "" : String(initial));
  const editingEmpty = useRef(false);

  useEffect(() => {
    // 清空数字时父层通常会把 null 归一化成 0；保留当前空草稿，避免输入框立即补回 0。
    if (editingEmpty.current && (value === 0 || value == null)) return;
    editingEmpty.current = false;
    setDraft(value == null ? "" : String(value));
  }, [value]);

  return (
    <Input
      {...props}
      type="number"
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        editingEmpty.current = raw === "";
        setDraft(raw);
        onChange?.(normalize(raw));
      }}
    />
  );
}

export interface SelectOption {
  label: ReactNode;
  value: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  size?: LegacySize;
  disabled?: boolean;
  searchable?: boolean;
  "aria-label"?: string;
  /** 透传到 <select>：调用方用它覆盖 CSS 里的 width:100%（年月日一行时必需） */
  style?: CSSProperties;
}

export function Select({
  options,
  value,
  defaultValue,
  onChange,
  placeholder,
  size = "md",
  searchable: _searchable,
  ...props
}: SelectProps) {
  return (
    <select
      {...props}
      className={joinClass("compat-select", `compat-${size}`)}
      value={value}
      defaultValue={defaultValue}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {typeof option.label === "string" || typeof option.label === "number" ? option.label : option.value}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// 内容层
// ---------------------------------------------------------------------------

/**
 * 项目内容卡片：底层使用新版官方 MaterialView，而不是实色 Card。
 * 本应用允许壁纸贯穿内容区，使用 Card 会把页面盖成大片纯白/纯黑色块；MaterialView
 * 才是上游为「不浮动但需要半透明材质」的内容容器提供的组件。
 */
export interface AppCardProps extends Omit<MaterialViewProps, "thickness"> {
  padding?: number;
  thickness?: MaterialViewProps["thickness"];
}

export function AppCard({
  padding = 16,
  thickness = "thin",
  radius = 18,
  className,
  style,
  ...props
}: AppCardProps) {
  return (
    <MaterialView
      {...props}
      className={joinClass("app-material-card", className)}
      thickness={thickness}
      radius={radius}
      style={{ padding, ...style }}
    />
  );
}

// 上游无等价物：Tag / Empty
export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  color?: "default" | "accent" | "success" | "warning" | "danger";
  closable?: boolean;
  onClose?: () => void;
  icon?: ReactNode;
  size?: "sm" | "md";
}

export function Tag({ color = "default", size = "md", icon, closable, onClose, children, className, ...props }: TagProps) {
  return (
    <span {...props} className={joinClass("compat-tag", `compat-tag-${color}`, `compat-${size}`, className)}>
      {icon}
      {children}
      {closable && (
        <button type="button" className="compat-tag-close" onClick={onClose} aria-label="移除">
          <CloseGlyph />
        </button>
      )}
    </span>
  );
}

export interface EmptyProps {
  image?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Empty({ image, title, description, children, className }: EmptyProps) {
  return (
    <div className={joinClass("compat-empty", className)}>
      {image && <div className="compat-empty-image">{image}</div>}
      {title && <div className="compat-empty-title">{title}</div>}
      {description && <div className="compat-empty-desc">{description}</div>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 导航（上游无等价物：SideNav）
// ---------------------------------------------------------------------------

export type SideNavItem =
  | { key: string; label: ReactNode; icon?: ReactNode; href?: string; disabled?: boolean }
  | { type: "group"; label: ReactNode };

export interface SideNavProps {
  items: SideNavItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (key: string) => void;
  "aria-label"?: string;
}

export function SideNav({ items, value, defaultValue, onChange, "aria-label": ariaLabel }: SideNavProps) {
  const [inner, setInner] = useState(defaultValue);
  const selected = value ?? inner;
  return (
    <nav className="compat-sidenav" aria-label={ariaLabel}>
      {items.map((item, index) => {
        if ("type" in item) {
          return (
            <div key={`group-${index}`} className="compat-sidenav-group">
              {item.label}
            </div>
          );
        }
        return (
          <button
            key={item.key}
            type="button"
            className={joinClass("compat-sidenav-item", selected === item.key && "is-active")}
            disabled={item.disabled}
            onClick={() => {
              setInner(item.key);
              onChange?.(item.key);
            }}
          >
            {item.icon && <span className="compat-sidenav-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// 数据展示（上游无等价物：Table）
// ---------------------------------------------------------------------------

export interface TableColumn<T> {
  key: string;
  title: ReactNode;
  dataIndex?: keyof T;
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  sorter?: (a: T, b: T) => number;
  align?: "left" | "center" | "right";
  width?: number | string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  rowKey: keyof T | ((row: T) => string);
  size?: LegacySize;
  emptyText?: ReactNode;
  "aria-label"?: string;
}

export function Table<T>({ columns, data, rowKey, size = "md", emptyText, "aria-label": ariaLabel }: TableProps<T>) {
  // 固定列遮罩只在真的横向溢出时启用：整表刚好放得下时叠遮罩会在内容材质上
  // 压出异色块（用户视角「卡片颜色不一致」）。用 ResizeObserver 跟窗口联动。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setOverflowing(el.scrollWidth - el.clientWidth > 2);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // 空表 ↔ 有数据切换时滚动容器才挂载/卸载，需要重挂观察器
  }, [data.length === 0]);
  const keyOf = (row: T): string => String(typeof rowKey === "function" ? rowKey(row) : row[rowKey]);
  if (data.length === 0) return <div className="compat-table-empty">{emptyText ?? "暂无数据"}</div>;
  return (
    <div ref={scrollRef} className={joinClass("compat-table-scroll", overflowing && "is-overflowing")}>
      <table className={joinClass("compat-table", `compat-${size}`)} aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ textAlign: column.align, width: column.width }}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr key={keyOf(row)}>
              {columns.map((column) => (
                <td key={column.key} style={{ textAlign: column.align, width: column.width }}>
                  {column.render
                    ? column.render(row, index)
                    : column.dataIndex
                      ? (row[column.dataIndex] as ReactNode)
                      : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 遮罩层（上游拆成 Dialog/Alert/Sheet/Popover，此处保留通用 Modal 形状）
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  closeOnOverlayClick?: boolean;
  children: ReactNode;
}

export interface ConfirmOptions {
  title?: ReactNode;
  content?: ReactNode;
  okText?: ReactNode;
  cancelText?: ReactNode;
  danger?: boolean;
  locale?: "zh-CN" | "en-US";
}

/**
 * 弹窗宽度按 size 档位**固定**（2026-10-10 改回）。
 *
 * 历史：0.14.14 为解决「内容少时被压成扁条」改成统一撑满可用宽度
 * （`width: calc(100vw - 32px)` + 面板 `width:100%`）。撑满确实不扁了，
 * 但矫枉过正 —— 几行字的确认框也从屏幕一头拉到另一头，空旷且找不到重点，
 * 用户 2026-10-10 要求改回固定大小。
 *
 * 所以这里恢复档位表（数值沿用 2026-10-09 之前那版：sm/md/lg = 420/560/780），
 * 差异在**不再用 max-width 让内容反向撑开**：宽度由档位定死，
 * 内容多时在弹窗内部滚动（.compat-modal-body 已有 max-height + overflow:auto）。
 *
 * ⚠️ 小屏保护放 CSS（max-width: calc(100vw - 32px)），别在 JS 里算视口 ——
 *    resize 时不会重算，而且 SSR/首帧拿不到尺寸。
 */
const MODAL_WIDTH = { sm: 420, md: 560, lg: 780 } as const;

function ModalBase({
  open,
  onOpenChange,
  title,
  footer,
  size = "md",
  closeOnOverlayClick = true,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // 用原生 <dialog> + showModal()：焦点containment、top layer 与 Escape 都由平台提供，
  // 不必手写 focus trap。此处不再挂全局 keydown —— 原生 Escape 会触发 cancel 事件，
  // 两套并存会导致 onOpenChange(false) 被调用两次。
  // CSS 里的 .compat-modal / .compat-modal::backdrop 正是按原生 dialog 编写的，
  // 换成自绘遮罩层会让这些规则全部落空（既无遮罩也无面板背景）。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="compat-modal"
      // 固定宽度由档位给；CSS 侧的 max-width 负责小屏不溢出。
      // 用 width 而不是 max-width —— 后者会让内容少的弹窗又被压窄，
      // 正是这次要避免的。
      style={{ width: MODAL_WIDTH[size] }}
      aria-label={typeof title === "string" ? title : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (closeOnOverlayClick && event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="compat-modal-panel">
        <div className="compat-modal-head">
          <h2>{title}</h2>
          <CloseButton size="sm" onClick={() => onOpenChange(false)} />
        </div>
        <div className="compat-modal-body">{children}</div>
        {footer && <div className="compat-modal-footer">{footer}</div>}
      </div>
    </dialog>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// imperative confirm（2026-11-25 用户要求「和主体 UI 统一」）
//
// 旧实现直接调 window.confirm 拼字符串：Electron 会弹一个白底系统对话框
// （标题栏是 app 名、系统按钮、无玻璃材质），okText / cancelText / danger
// 全部被忽略，和主体的液态玻璃界面完全是两套语言。
//
// 现在仍保持 `await Modal.confirm(...)` 的 Promise 接口，但由 <ModalConfirmHost>
// 用项目自己的 .compat-modal 玻璃面板渲染。confirm() 不在 React 树里，所以用
// 模块级队列 + useSyncExternalStore 通知 Host；Host 挂在 LiquidGlassConfig
// （GlassProvider）内，GlassButton 才能拿到当前主题。
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

type ConfirmListener = () => void;
const confirmListeners = new Set<ConfirmListener>();
/** 快照必须是稳定引用：每次变更都换成新数组，useSyncExternalStore 才能检测到。 */
let confirmQueue: ConfirmRequest[] = [];
let confirmSeq = 0;

function subscribeConfirm(listener: ConfirmListener) {
  confirmListeners.add(listener);
  return () => {
    confirmListeners.delete(listener);
  };
}

function getConfirmQueue() {
  return confirmQueue;
}

function notifyConfirm() {
  for (const fn of confirmListeners) fn();
}

function settleConfirm(id: number, ok: boolean) {
  const target = confirmQueue.find((q) => q.id === id);
  if (!target) return; // Esc 与按钮连点时只结算一次，不重复 resolve
  confirmQueue = confirmQueue.filter((q) => q.id !== id);
  notifyConfirm();
  target.resolve(ok);
}

function confirm(options: ConfirmOptions = {}): Promise<boolean> {
  // 宿主没挂载时（例如加载态的 early-return 分支）不能让 Promise 永远悬着：
  // 明确按「取消」结算，绝不退回 window.confirm 把系统弹窗又放回来。
  if (confirmListeners.size === 0) {
    console.warn("Modal.confirm: 未挂载 ModalConfirmHost，已按「取消」处理");
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    confirmQueue = [...confirmQueue, { id: ++confirmSeq, options, resolve }];
    notifyConfirm();
  });
}

const CONFIRM_BULLET_RE = /^\s*[·•\-]\s*/;

/** 把 `\n\n` 分段、`· ` 行排成列表，避免原生 confirm 那种一整坨纯文本。 */
function ConfirmContent({ content, danger }: { content?: ReactNode; danger?: boolean }) {
  if (content == null || typeof content !== "string") {
    return <div className="cp-body confirm-body">{content ?? "确定继续吗？"}</div>;
  }
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className="cp-body confirm-body" data-danger={danger ? "true" : undefined}>
      {blocks.map((block, bi) => {
        const lines = block
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const bullets = lines.filter((l) => CONFIRM_BULLET_RE.test(l));
        const texts = lines.filter((l) => !CONFIRM_BULLET_RE.test(l));
        return (
          <div className="confirm-block" key={bi}>
            {texts.length > 0 && (
              <p className={bullets.length > 0 ? "confirm-label" : undefined}>
                {texts.map((t, ti) => (
                  <span key={ti}>
                    {ti > 0 && <br />}
                    {t}
                  </span>
                ))}
              </p>
            )}
            {bullets.length > 0 && (
              <ul className="confirm-list">
                {bullets.map((b, i) => (
                  <li key={i}>{b.replace(CONFIRM_BULLET_RE, "")}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 挂在 GlassProvider 内；整棵应用只需一个实例（LiquidGlassConfig 已自带）。 */
export function ModalConfirmHost() {
  const queue = useSyncExternalStore(subscribeConfirm, getConfirmQueue, getConfirmQueue);
  const current = queue[0];
  const settle = (ok: boolean) => {
    if (current) settleConfirm(current.id, ok);
  };
  return (
    <Modal
      open={!!current}
      onOpenChange={(o) => {
        if (!o) settle(false);
      }}
      title={current?.options.title ?? ""}
      size="md"
      footer={
        <div className="confirm-footer">
          {/* 次要操作沿用主体的 plain 文字按钮；主操作必须有填充，
              否则两个纯文字并排时看不出哪个是确认（实测 destructive 是红字无底）。 */}
          <GlassButton variant="plain" controlSize="small" onClick={() => settle(false)}>
            {current?.options.cancelText ?? "取消"}
          </GlassButton>
          <GlassButton
            variant={current?.options.danger ? "destructiveProminent" : "glassProminent"}
            controlSize="small"
            onClick={() => settle(true)}
          >
            {current?.options.okText ?? "确定"}
          </GlassButton>
        </div>
      }
    >
      <ConfirmContent content={current?.options.content} danger={current?.options.danger} />
    </Modal>
  );
}

export const Modal = Object.assign(ModalBase, { confirm });

// ---------------------------------------------------------------------------
// 装饰（上游用 ScrollEdge 取代，语义不同，保留原实现）
// ---------------------------------------------------------------------------

export interface ProgressiveBlurProps {
  direction?: "to-top" | "to-bottom";
  size?: number | string;
  maxBlur?: number;
  className?: string;
}

export function ProgressiveBlur({ direction = "to-bottom", size = 28, maxBlur = 10, className }: ProgressiveBlurProps) {
  return (
    <div
      aria-hidden="true"
      className={joinClass("compat-progressive-blur", className)}
      style={{
        height: size,
        backdropFilter: `blur(${maxBlur}px)`,
        WebkitBackdropFilter: `blur(${maxBlur}px)`,
        maskImage: `linear-gradient(${direction}, black, transparent)`,
        WebkitMaskImage: `linear-gradient(${direction}, black, transparent)`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 主题 / 提示 / 环境色
// ---------------------------------------------------------------------------

export interface LiquidGlassConfigProps {
  forceFallback?: boolean;
  forceReducedTransparency?: boolean;
  /** 项目 useTheme() 已解析出的实际主题，必须与 <html data-theme> 保持一致。 */
  appearance?: "light" | "dark";
  /** 项目级 CSS token（accent / ambient），不是 GlassProvider 的 theme。 */
  theme?: CSSProperties;
  children: ReactNode;
}

export function createTheme(tokens: { accent?: string; ambient?: string }): CSSProperties {
  return {
    "--lg-accent": tokens.accent,
    "--lg-ambient": tokens.ambient,
  } as CSSProperties;
}

export function LiquidGlassConfig({
  forceFallback,
  forceReducedTransparency,
  appearance = "dark",
  theme,
  children,
}: LiquidGlassConfigProps) {
  return (
    <GlassProvider
      transparency={forceFallback || forceReducedTransparency ? "reduced" : "system"}
      theme={appearance}
    >
      <div className="compat-provider" data-lg-theme={appearance} style={theme}>
        {children}
        {/* imperative Modal.confirm 的渲染宿主：必须位于 GlassProvider 内，
            否则 footer 的 GlassButton 拿不到当前主题。Modal 自身用 portal
            挂到 body，放进这个 display:contents 容器不影响页面布局。 */}
        <ModalConfirmHost />
      </div>
    </GlassProvider>
  );
}

type ToastKind = "default" | "success" | "error" | "info";
interface ToastEntry {
  id: string;
  content: ReactNode;
  kind: ToastKind;
  duration: number;
}
type ToastListener = (entry: ToastEntry | null, dismissId?: string) => void;
const toastListeners = new Set<ToastListener>();
let toastSeq = 0;

function emitToast(content: ReactNode, kind: ToastKind, duration = 3200): string {
  const id = `toast-${++toastSeq}`;
  const entry = { id, content, kind, duration };
  toastListeners.forEach((listener) => listener(entry));
  return id;
}

export const toast = {
  show: (content: ReactNode, options?: { duration?: number; kind?: ToastKind }) =>
    emitToast(content, options?.kind || "default", options?.duration),
  success: (content: ReactNode, options?: { duration?: number }) => emitToast(content, "success", options?.duration),
  error: (content: ReactNode, options?: { duration?: number }) => emitToast(content, "error", options?.duration ?? 4500),
  info: (content: ReactNode, options?: { duration?: number }) => emitToast(content, "info", options?.duration),
  dismiss: (id?: string) => toastListeners.forEach((listener) => listener(null, id)),
};

export interface ToasterProps {
  position?: "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
  max?: number;
}

export function Toaster({ position = "bottom-right", max = 3 }: ToasterProps) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  useEffect(() => {
    const listener: ToastListener = (entry, dismissId) => {
      if (dismissId) {
        setItems((current) => (dismissId ? current.filter((item) => item.id !== dismissId) : []));
        return;
      }
      if (!entry) {
        setItems([]);
        return;
      }
      setItems((current) => [...current, entry].slice(-max));
      window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== entry.id)), entry.duration);
    };
    toastListeners.add(listener);
    return () => {
      toastListeners.delete(listener);
    };
  }, [max]);
  if (items.length === 0) return null;
  return createPortal(
    <div className={joinClass("compat-toaster", `compat-toaster-${position}`)} aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={joinClass("compat-toast", `compat-toast-${item.kind}`)}>
          <span>{item.content}</span>
          <CloseButton
            size="sm"
            onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
          />
        </div>
      ))}
    </div>,
    document.body
  );
}

export function useAmbientFromImage(
  url: string | null,
  options?: { strategy?: "average" | "edge"; alpha?: number }
): string | null {
  const [color, setColor] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    if (!url) {
      setColor(null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, 16, 16);
        const data = context.getImageData(0, 0, 16, 16).data;
        let red = 0,
          green = 0,
          blue = 0,
          count = 0;
        for (let index = 0; index < data.length; index += 16) {
          red += data[index];
          green += data[index + 1];
          blue += data[index + 2];
          count++;
        }
        setColor(
          `rgba(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)}, ${
            options?.alpha ?? 0.16
          })`
        );
      } catch {
        setColor(null);
      }
    };
    image.onerror = () => {
      if (!cancelled) setColor(null);
    };
    image.src = url + (url.includes("#") ? "" : `#ambient-${id}`);
    return () => {
      cancelled = true;
    };
  }, [id, options?.alpha, options?.strategy, url]);
  return color;
}
