import { Button, Card, GlassSurface, Tag, toast } from "@ttqtt/liquid-glass-react";

/**
 * 关于页面：版本信息 + 第三方依赖清单 + 友情链接。
 *
 * 外链行为：主进程已注册 `setWindowOpenHandler`，`<a target="_blank">` 会被
 * 交给系统默认浏览器打开（不会在应用内开新窗口），因此这里直接用 <a> 即可，
 * 无需新增 IPC 通道；Web/Docker 版走浏览器本身的默认行为，同样正常。
 */

/** 复制文本：优先用剪贴板 API，失败时（非安全上下文）回落到旧接口 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const APP_VERSION = "0.9.2";

/** 直接依赖（package.json 中声明的运行时依赖） */
const DIRECT_DEPS: { name: string; version: string; license: string; desc: string }[] = [
  {
    name: "Electron",
    version: "31.7.7",
    license: "MIT",
    desc: "跨平台桌面应用外壳，提供主进程 / 渲染进程与系统集成能力",
  },
  {
    name: "Playwright Core",
    version: "1.62.1",
    license: "Apache-2.0",
    desc: "驱动独立 Chromium 完成登录授权与页面自动化",
  },
  {
    name: "React",
    version: "18.3.1",
    license: "MIT",
    desc: "渲染层界面框架",
  },
  {
    name: "React DOM",
    version: "18.3.1",
    license: "MIT",
    desc: "React 的浏览器渲染实现",
  },
  {
    name: "@ttqtt/liquid-glass-react",
    version: "0.2.0",
    license: "MIT",
    desc: "液态玻璃 UI 组件库（玻璃面板、按钮、卡片、开关、滑动条等全部界面控件）",
  },
];

/** 间接依赖（由上述直接依赖传递引入，随安装包一同分发） */
const TRANSITIVE_DEPS: { name: string; version: string; license: string }[] = [
  { name: "@floating-ui/react", version: "0.27.20", license: "MIT" },
  { name: "@floating-ui/react-dom", version: "2.1.9", license: "MIT" },
  { name: "@floating-ui/core", version: "1.8.0", license: "MIT" },
  { name: "@floating-ui/dom", version: "1.8.0", license: "MIT" },
  { name: "@floating-ui/utils", version: "0.2.12", license: "MIT" },
  { name: "tabbable", version: "6.5.0", license: "MIT" },
  { name: "scheduler", version: "0.23.2", license: "MIT" },
  { name: "js-tokens", version: "4.0.0", license: "MIT" },
  { name: "loose-envify", version: "1.4.0", license: "MIT" },
];

/** 构建期工具链（不随安装包分发，开发 / 打包时使用） */
const DEV_DEPS: { name: string; version: string; license: string }[] = [
  { name: "TypeScript", version: "5.9.3", license: "Apache-2.0" },
  { name: "Vite", version: "5.4.21", license: "MIT" },
  { name: "@vitejs/plugin-react", version: "4.7.0", license: "MIT" },
  { name: "electron-builder", version: "25.1.8", license: "MIT" },
  { name: "rcedit", version: "5.0.2", license: "MIT" },
];

/** 友情链接：作者邀请 / 赞助通道 */
const LINKS = [
  {
    key: "akile",
    href: "https://akile.ai/register?aff_code=1d7e06e0-2922-457e-bada-f814833f7c40",
    name: "AkileCloud",
    title: "AI 网关 / 云服务",
    desc: "本项目开发环境使用的 AI 网关服务，注册即赠体验额度",
    tint: "#3b82f6",
  },
  {
    key: "workbuddy",
    href: "https://www.workbuddy.cn/events/invite?inviteCode=3450jecx6c6",
    name: "WorkBuddy",
    title: "AI 助手 / 工作搭子",
    desc: "本项目的开发助手，从写码到跑测试、打包发版全程参与",
    tint: "#8b5cf6",
  },
];

export function About() {
  const onCopy = async (text: string, label: string) => {
    const ok = await copyText(text);
    if (ok) toast.success(`${label}已复制到剪贴板`);
    else toast.error("复制失败，请手动选中链接复制");
  };

  return (
    <>
      {/* ---- 版本信息 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">关于本软件</div>
            <div className="block-sub">版本信息、开源依赖与友情链接</div>
          </div>
          <Tag color="accent" size="sm">
            v{APP_VERSION}
          </Tag>
        </div>

        <Card padding="md">
          <div className="about-hero">
            <img className="about-logo" src="./icon.png" alt="" draggable={false} />
            <div style={{ minWidth: 0 }}>
              <div className="about-name">Microsoft Rewards Auto</div>
              <div className="about-ver">版本 v{APP_VERSION} · MIT License</div>
              <div className="hint" style={{ marginTop: 6 }}>
                Electron + Playwright 多账户自动任务工具。本软件为个人学习交流用途的开源项目，
                <b>非微软官方授权产品</b>，与 Microsoft Corporation 无任何关联。
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ---- 运行时依赖 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">第三方开源组件</div>
            <div className="block-sub">
              本软件基于以下开源项目构建，在此向所有作者与社区致谢
            </div>
          </div>
          <Tag size="sm">{DIRECT_DEPS.length + TRANSITIVE_DEPS.length + DEV_DEPS.length} 个</Tag>
        </div>

        <Card padding="md">
          <div className="dep-group-title">直接依赖（随安装包分发）</div>
          <div className="dep-list">
            {DIRECT_DEPS.map((d) => (
              <div className="dep-item" key={d.name}>
                <div className="dep-main">
                  <span className="dep-name">{d.name}</span>
                  <span className="dep-ver">{d.version}</span>
                </div>
                <div className="dep-desc">{d.desc}</div>
                <Tag size="sm">{d.license}</Tag>
              </div>
            ))}
          </div>

          <div className="dep-group-title" style={{ marginTop: 18 }}>
            间接依赖（由上述项目传递引入）
          </div>
          <div className="dep-chips">
            {TRANSITIVE_DEPS.map((d) => (
              <span className="dep-chip" key={d.name} title={`${d.name} · ${d.license}`}>
                {d.name}
                <span className="dep-chip-ver">{d.version}</span>
              </span>
            ))}
          </div>

          <div className="dep-group-title" style={{ marginTop: 18 }}>
            构建工具链（仅开发与打包时使用，不随安装包分发）
          </div>
          <div className="dep-chips">
            {DEV_DEPS.map((d) => (
              <span className="dep-chip" key={d.name} title={`${d.name} · ${d.license}`}>
                {d.name}
                <span className="dep-chip-ver">{d.version}</span>
              </span>
            ))}
          </div>

          <div className="hint" style={{ marginTop: 16 }}>
            完整依赖树与许可证文本可在安装目录的 `node_modules` 中查看；各项目均按其各自的
            开源许可证授权，版权归原作者所有。
          </div>
        </Card>
      </div>

      {/* ---- 友情链接 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">友情链接</div>
            <div className="block-sub">通过以下邀请链接注册，可支持本项目的持续开发</div>
          </div>
        </div>

        <Card padding="md">
          <div className="friend-list">
            {LINKS.map((l) => (
              <div className="friend-item" key={l.key}>
                <GlassSurface as="div" className="friend-logo" radius={14}>
                  {l.key === "akile" ? (
                    <svg className="friend-mark" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M42.919 11.923L25 1.577a2 2 0 00-2 0L5.081 11.923a2 2 0 00-1 1.732v20.69a2 2 0 001 1.732L23 46.423a2 2 0 002 0l17.919-10.346a2 2 0 001-1.732v-20.69a2 2 0 00-1-1.732zM30.556 9.525L38.5 14 24 23l-13.808-8.668L17.5 10l6.5 4 6.556-4.475zM22 40.441V26.286L8 17.358v7.928l8 5.464v6.227l6 3.464zm10-3.464l-6 3.464V26.286l14-8.928v8.928l-8 5.464v5.227z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <svg className="friend-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                      {/* 助手标记：对话气泡 + 星芒，寓意「一起把活干完」 */}
                      <rect
                        x="6"
                        y="9"
                        width="36"
                        height="26"
                        rx="9"
                        stroke="currentColor"
                        strokeWidth="2.6"
                      />
                      <path
                        d="M16 35v6.5L24.5 35"
                        stroke="currentColor"
                        strokeWidth="2.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M24 15.5l2.3 4.9 5.2.6-3.9 3.6 1.1 5.2L24 27.2l-4.7 2.6 1.1-5.2-3.9-3.6 5.2-.6z"
                        fill="currentColor"
                      />
                    </svg>
                  )}
                </GlassSurface>

                <div className="friend-main">
                  <div className="friend-head">
                    <span className="friend-name">{l.name}</span>
                    <Tag color={l.key === "akile" ? "accent" : "success"} size="sm">
                      {l.title}
                    </Tag>
                  </div>
                  <div className="friend-desc">{l.desc}</div>
                  <div className="friend-url" title={l.href}>
                    {l.href}
                  </div>
                </div>

                <div className="friend-actions">
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => window.open(l.href, "_blank", "noopener")}
                  >
                    ↗ 前往注册
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void onCopy(l.href, l.name)}>
                    ⧉ 复制链接
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="hint" style={{ marginTop: 14 }}>
            链接为作者邀请链接，你注册后作者可获得少量额度回馈，价格与常规注册一致，
            不会增加你的任何成本。
          </div>
        </Card>
      </div>

      {/* ---- 开源许可摘要 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">开源许可</div>
          </div>
        </div>
        <Card padding="md">
          <div className="hint" style={{ lineHeight: 1.7 }}>
            本软件以 MIT 许可证开源发布，源码托管于 GitHub。软件按「现状」提供，不附带任何
            明示或默示的担保。使用本软件产生的风险由使用者自行承担，请遵守 Microsoft
            服务条款与当地法律法规。
          </div>
          <div className="about-actions">
            <Button
              variant="glass"
              size="sm"
              onClick={() =>
                window.open("https://github.com/zefeng1236/ms-rewards-auto", "_blank", "noopener")
              }
            >
              ⌘ 项目仓库
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                window.open(
                  "https://github.com/zefeng1236/ms-rewards-auto/releases",
                  "_blank",
                  "noopener"
                )
              }
            >
              ↓ 历史版本
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
