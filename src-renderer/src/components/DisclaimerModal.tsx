import { useEffect, useState } from "react";
import { Button, Modal } from "@ttqtt/liquid-glass-react";

/**
 * 第三方随机图片免责声明。
 * 「确定启用」按钮带 3 秒倒计时，避免用户无意识点过。
 */
export function DisclaimerModal({
  open,
  onAgree,
  onCancel,
}: {
  open: boolean;
  onAgree: () => void;
  onCancel: () => void;
}) {
  const [left, setLeft] = useState(3);

  useEffect(() => {
    if (!open) return;
    setLeft(3);
    const timer = window.setInterval(() => {
      setLeft((v) => {
        if (v <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="第三方随机图片声明"
      size="md"
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            不启用
          </Button>
          <Button variant="accent" size="sm" onClick={onAgree} disabled={left > 0}>
            {left > 0 ? `确定启用（${left}s）` : "确定启用"}
          </Button>
        </div>
      }
    >
      <div className="disclaimer">
        <p>
          您即将启用 <b>第三方随机图片</b> 作为应用背景，继续前请阅读：
        </p>
        <ul>
          <li>
            图片由第三方接口（<b>UAPI</b>、<b>98qy</b>、<b>Unsplash</b>）实时随机返回，
            <span className="hl">均来源于公共互联网</span>
            ，本应用不托管、不存储、不加工这些图片。
          </li>
          <li>
            作者 <span className="hl">未对图片内容做任何审核、筛选或背书</span>
            ；图片版权归原作者及原网站所有。
          </li>
          <li>
            图片为随机返回，<span className="hl">可能出现您不喜欢或引起不适的内容</span>
            ；如遇不适，请点「换一张」或关闭该功能。
          </li>
          <li>因使用第三方图片或服务产生的任何争议或损失，由相应第三方服务方及使用者自行承担。</li>
        </ul>
        <p className="disclaimer-foot">点「确定启用」即表示您已知晓并同意以上内容。</p>
      </div>
    </Modal>
  );
}
