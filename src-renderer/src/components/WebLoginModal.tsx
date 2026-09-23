import { GlassButton } from "@ttqtt/liquid-glass-react";
import { Modal } from "./liquidGlassCompat";

/**
 * Web / Docker 版「授权登录」前的说明弹窗。
 *
 * 容器里弹出的浏览器不会显示在用户自己的屏幕上（它渲染在 noVNC 的虚拟桌面里），
 * 所以点「授权登录」必须先告诉用户去哪儿看 —— 否则点了什么也没发生，
 * 用户只会以为「没弹窗 / 卡住了」，然后干等到浏览器超时被回收。
 *
 * 仪表盘和账户详情页都要走这一层，抽出来避免两边各写一份、改一处漏一处。
 */
export function WebLoginModal({
  open,
  accountName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  accountName?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="登录说明"
      size="md"
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <GlassButton variant="plain" controlSize="small" onClick={onCancel}>
            取消登录
          </GlassButton>
          <GlassButton variant="glassProminent" controlSize="small" onClick={onConfirm}>
            打开远程桌面
          </GlassButton>
        </div>
      }
    >
      <div style={{ lineHeight: 1.8 }}>
        <p>
          登录将在 <b>服务器浏览器</b> 中完成
          {accountName ? `（账户「${accountName}」）` : ""}，请按以下步骤操作：
        </p>
        <ol style={{ paddingLeft: 20, margin: "8px 0" }}>
          <li>点击下方「打开远程桌面」按钮，会在新标签页打开 noVNC</li>
          <li>在 noVNC 页面中点击 <b>「连接」</b> 按钮进入远程桌面</li>
          <li>在远程桌面的浏览器中完成MS账号授权登录</li>
          <li>登录成功后远程桌面会显示「登录已完成」，返回本页面即可</li>
        </ol>
        <p className="hint">
          远程桌面需要用 login profile 启动（见 docker/README.md）；没启动时上面的端口打不开。
        </p>
      </div>
    </Modal>
  );
}
