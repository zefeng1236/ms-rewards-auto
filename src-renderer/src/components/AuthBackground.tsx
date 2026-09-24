import { useAppState } from "../hooks/useAppState";
import { useAuthBg } from "../hooks/useAuthBg";
import { FlowFieldBg } from "./FlowFieldBg";

/**
 * 登录页 / 初始化向导的统一背景层。
 *
 * authBg = flow（默认）→ Canvas 流场粒子动画 + 轻衬底；
 * authBg = bing        → 必应每日一图（复用主界面壁纸层样式：模糊 + 暗化 + 衬底）。
 *
 * 只在向导和登录页渲染——主界面软件不出现流场（用户明确要求的分工）。
 * 与 App.tsx 主界面的 bgLayer 互不相干。
 */
export function AuthBackground() {
  const { authBg, src } = useAuthBg();
  const { appearance } = useAppState();

  if (authBg === "flow") {
    return (
      <>
        <FlowFieldBg />
        <div className="flow-scrim" />
      </>
    );
  }

  if (src) {
    return (
      <>
        <div className="bg-layer">
          <div
            className="bg-image"
            style={{
              backgroundImage: `url("${src}")`,
              filter: `blur(${appearance?.bgBlur ?? 4}px)`,
            }}
          />
          <div className="bg-tint" />
        </div>
        <div className="shell-scrim" />
      </>
    );
  }

  return null;
}
