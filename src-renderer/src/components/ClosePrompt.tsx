import { useState, type CSSProperties } from "react";
import { Button, Modal } from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";

/**
 * 点击 × 关闭主窗口时的「每次询问」选项卡。
 *
 * 布局约定（用户明确要求）：
 *   - 「记住我的选择」复选框在最左边；
 *   - 「退出到托盘」在最右边、用主题色（accent）强调——这是推荐路径；
 *   - 「完全退出」放次右；右上角的 ×（Modal 自带）仅关闭本弹窗，窗口保持打开。
 * 勾选记住后，选择会写入 launch.json 的 closeAction，之后点 × 不再询问。
 */
export function ClosePrompt({ onClose }: { onClose: () => void }) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async (choice: "tray" | "exit") => {
    if (busy) return;
    setBusy(true);
    try {
      await api.closeChoice(choice, remember);
    } catch {
      // 主进程不可达时保守处理：仅收起弹窗，窗口保持打开
    }
    onClose();
  };

  const footerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="关闭软件"
      size="sm"
      closeOnOverlayClick={false}
      footer={
        <div style={footerStyle}>
          <button
            type="button"
            className={remember ? "wz-check on cp-remember" : "wz-check cp-remember"}
            onClick={() => setRemember((v) => !v)}
          >
            <span className="wz-check-box">{remember ? "✓" : ""}</span>
            记住我的选择
          </button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => void choose("exit")}>
            完全退出
          </Button>
          <Button variant="accent" size="sm" onClick={() => void choose("tray")}>
            退出到托盘
          </Button>
        </div>
      }
    >
      <div className="cp-body">
        <p>要退出到托盘还是完全退出？</p>
        <p className="cp-hint">
          <b>退出到托盘</b>：窗口隐藏，任务和定时调度继续在后台运行。
          <br />
          <b>完全退出</b>：结束进程，所有任务与定时调度停止。
        </p>
      </div>
    </Modal>
  );
}
