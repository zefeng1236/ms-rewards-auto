import { useEffect, useRef } from "react";
import { Personalize } from "./Personalize";
import { LaunchSettings } from "./LaunchSettings";
import { FingerprintBrowserPanel } from "../components/FingerprintBrowserPanel";
import { VaultPanel } from "../components/VaultPanel";
import { IS_WEB } from "../api/ipc";

/**
 * 软件设置的分类清单：左侧边栏选项卡与本页分区共用同一份，
 * 「启动与托盘」是桌面端专属（Docker/Web 版由 compose 的 restart 策略接管），自动隐藏。
 */
export const SOFTWARE_SECTIONS: { key: string; label: string }[] = IS_WEB
  ? [
      { key: "personalize", label: "个性化" },
      { key: "browser", label: "浏览器" },
      { key: "security", label: "安全" },
    ]
  : [
      { key: "personalize", label: "个性化" },
      { key: "launch", label: "启动与托盘" },
      { key: "browser", label: "浏览器" },
      { key: "security", label: "安全" },
    ];

/**
 * 软件设置（独立标签页）
 *
 * 承接从原「全局设置」拆出来的、与积分任务无关的软件自身行为配置，
 * 按大类分区展示：外观个性化 / 启动与托盘 / 浏览器 / 安全。
 *
 * 与侧边栏的联动（见 App.tsx 的 handleSwSectionClick / handleSwSpy）：
 *   - 点侧栏选项卡 → scrollIntoView 平滑滚动到对应分区；
 *   - 右侧滚动 → 本页 scroll-spy 上报当前分区，侧栏胶囊跟着滑过去。
 * 两侧共用 .sec 分区结构，分区 id 规约为 `swsec-<key>`。
 */
export function SoftwareSettingsView({
  bgSrc,
  onShuffle,
  onSpySec,
}: {
  bgSrc: string;
  onShuffle?: () => void;
  onSpySec?: (key: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 回调放进 ref，滚动监听只挂一次，不随父组件重渲染反复解绑
  const spyRef = useRef(onSpySec);
  spyRef.current = onSpySec;

  // scroll-spy：右侧滚动时计算当前所处分类并上报。
  // 点击侧栏选项卡后的平滑滚动期间由 App 侧加锁忽略上报，防止胶囊来回跳。
  useEffect(() => {
    const container = rootRef.current?.closest(".scroll-area");
    if (!container) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const cr = container.getBoundingClientRect();
      let current = SOFTWARE_SECTIONS[0].key;
      let best = -Infinity;
      for (const s of SOFTWARE_SECTIONS) {
        const el = document.getElementById(`swsec-${s.key}`);
        if (!el) continue;
        const rel = el.getBoundingClientRect().top - cr.top;
        // 取「顶部已越过容器顶部阈值」的最后一个分区
        if (rel <= 140 && rel > best) {
          best = rel;
          current = s.key;
        }
      }
      // 滚到底：强制选中最后一节（短分区可能永远够不到顶部阈值）
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 6) {
        current = SOFTWARE_SECTIONS[SOFTWARE_SECTIONS.length - 1].key;
      }
      spyRef.current?.(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={rootRef}>
      {/* 分类 ①：外观个性化 */}
      <div className="sec sw-sec" id="swsec-personalize">
        <div className="sec-title">个性化</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          主题、壁纸与液态玻璃外观，全部即时生效
        </div>
        <Personalize bgSrc={bgSrc} onShuffle={onShuffle} />
      </div>

      {/* 分类 ②：启动与托盘（桌面端语义，Docker 版由 compose 的 restart 策略接管） */}
      {!IS_WEB && (
        <div className="sec sw-sec" id="swsec-launch">
          <div className="sec-title">启动与托盘</div>
          <div className="hint" style={{ marginBottom: 8 }}>
            开机自启动、驻留托盘与关闭行为等系统级设置
          </div>
          <LaunchSettings />
        </div>
      )}

      {/* 分类 ③：浏览器（环境拟真浏览器来源 / 下载 / 更新 / 删除） */}
      <div className="sec sw-sec" id="swsec-browser">
        <div className="sec-title">浏览器</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          {IS_WEB
            ? "用于登录授权与页面自动化的浏览器来源：Docker 版镜像内已预装环境拟真浏览器，且容器里只有它可用"
            : "用于登录授权与页面自动化的浏览器来源，默认启用环境拟真浏览器（未安装时自动回落普通 Chromium）"}
        </div>
        <FingerprintBrowserPanel />
      </div>

      {/* 分类 ④：安全（登录态加密存储） */}
      <div className="sec sw-sec" id="swsec-security">
        <div className="sec-title">安全</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          账户登录态的加密存储与保险库管理
        </div>
        <VaultPanel />
      </div>
    </div>
  );
}
