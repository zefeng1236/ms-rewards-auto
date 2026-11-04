import { GlassButton } from "@ttqtt/liquid-glass-react";
import { Modal } from "./liquidGlassCompat";

/**
 * 「未安装微软 Rewards 桌面应用」引导弹窗。
 *
 * 为什么必须拦一道（2026-11-02）：
 *   「桌面应用专属任务」靠外部程序驱动微软自家的 Rewards 桌面应用完成，
 *   不装就必然跑不起来。如果允许直接把开关拨开，用户只会看到汇总行天天报
 *   「未安装 Rewards 应用」，却不知道去哪装 —— 所以要当场引导。
 *
 * 开关本身保持关闭：装了之后用户再拨一次即可（那时检测会通过）。
 */
export function DesktopAppMissingDialog({
  open,
  busy,
  onCancel,
  onOpenStore,
}: {
  open: boolean;
  /** 正在唤起 Microsoft Store，期间禁用按钮防连点 */
  busy?: boolean;
  onCancel: () => void;
  onOpenStore: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="未检测到微软 Rewards 桌面应用"
      size="sm"
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <div style={{ flex: 1 }} />
          <GlassButton variant="plain" controlSize="small" onClick={onCancel}>
            暂不
          </GlassButton>
          <GlassButton variant="glassProminent" controlSize="small" onClick={onOpenStore} disabled={busy}>
            {busy ? "正在打开…" : "去 Microsoft Store 安装"}
          </GlassButton>
        </div>
      }
    >
      <div className="cp-body">
        <p>
          「桌面应用专属任务」需要借助微软自家的 <b>Microsoft Rewards</b> 桌面应用完成，
          当前没有检测到它已安装，因此这个开关暂时不会生效。
        </p>
        <p className="cp-hint">
          可以从 Microsoft Store 免费安装。装好之后请<b>先打开应用、登录一次微软账号</b> ——
          这些任务用的是应用自己的登录态，与本软件的登录状态无关。
          <br />
          安装完成后回到这里再拨一次开关即可。
        </p>
      </div>
    </Modal>
  );
}
