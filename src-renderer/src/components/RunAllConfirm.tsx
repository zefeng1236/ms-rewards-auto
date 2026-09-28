import { useEffect, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { Modal } from "./liquidGlassCompat";

/** 二次确认前的强制冷静期（秒）——用户明确要求 5 秒 */
const COUNTDOWN_SEC = 5;

/**
 * 「立即一次性完成」的二次确认弹窗。支持单账户与全局两种语义。
 *
 * 为什么要点一下都不能立刻生效：
 *   这个按钮会一次性把当天任务全部跑完，并且**忽略**每个任务配置的
 *   「单次执行数量」（那种「把任务摊到多轮慢慢做」的反自动化策略）。
 *   也就是说按下去等于主动放弃了分批掩护 —— 属于高风险操作，必须拦一道。
 *
 * 两道闸门：
 *   1. 5 秒倒计时期间「确认」按钮禁用（防手滑连点）；
 *   2. 倒计时结束后仍需用户再点一次确认（防把弹窗当进度条直接回车关掉）。
 */
export function RunAllConfirm({
  open,
  count,
  accountName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** 本次会运行的已启用账户数，0 表示没有可运行的账户 */
  count: number;
  /** 单账户模式下传入账户名，文案切换为「该账户」语义 */
  accountName?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [left, setLeft] = useState(COUNTDOWN_SEC);

  // 每次重新打开都从 5 秒开始倒数（关掉再开不能继承上一轮的剩余时间）
  useEffect(() => {
    if (open) setLeft(COUNTDOWN_SEC);
  }, [open]);

  useEffect(() => {
    if (!open || left <= 0) return;
    const t = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [open, left]);

  const ready = left <= 0;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title={accountName ? `立即完成「${accountName}」的全部任务` : "立即完成全部任务"}
      size="sm"
      closeOnOverlayClick={false}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <span className="hint" style={{ margin: 0 }}>
            {ready ? "可以确认了" : `请仔细阅读，${left} 秒后可确认`}
          </span>
          <div style={{ flex: 1 }} />
          <GlassButton variant="plain" controlSize="small" onClick={onCancel}>
            取消
          </GlassButton>
          <GlassButton
            variant="destructive"
            controlSize="small"
            onClick={onConfirm}
            disabled={!ready}
            title={ready ? "开始运行" : "倒计时结束前不可确认"}
          >
            {ready ? "确认执行" : `确认执行（${left}s）`}
          </GlassButton>
        </div>
      }
    >
      <div className="cp-body">
        <p>
          {accountName ? (
            <>将运行账户 <b>{accountName}</b> 的全部任务。</>
          ) : (
            <>将依次运行 <b>{count}</b> 个已启用账户的全部任务。</>
          )}
        </p>
        <p className="cp-hint">
          本次会<b>忽略「单次执行数量」限制</b>（每个阅读/积分活动任务不再分批），
          一轮跑完当天全部任务 —— 相当于不使用分批掩护，请在合适的时候使用。
          <br />
          运行期间请勿关闭软件；中途可在顶栏点「停止」中断。
        </p>
      </div>
    </Modal>
  );
}
