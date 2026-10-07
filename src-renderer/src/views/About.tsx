import { useEffect, useState } from "react";
import { GlassButton, GlassSurface } from "@ttqtt/liquid-glass-react";
import { AppCard, Tag, toast } from "../components/liquidGlassCompat";
import { useAppState } from "../hooks/useAppState";
import { api } from "../api/ipc";
import { DISPLAY_VERSION as APP_VERSION } from "../version";

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

/** 直接依赖（package.json 中声明的运行时依赖） */
const DIRECT_DEPS: { name: string; version: string; license: string; desc: string; url: string }[] = [
  {
    name: "Electron",
    version: "31.7.7",
    license: "MIT",
    desc: "跨平台桌面应用外壳，提供主进程 / 渲染进程与系统集成能力",
    url: "https://github.com/electron/electron",
  },
  {
    name: "Playwright Core",
    version: "1.62.1",
    license: "Apache-2.0",
    desc: "驱动独立 Chromium 完成登录授权与页面自动化",
    url: "https://github.com/microsoft/playwright",
  },
  {
    name: "React",
    version: "19.3.0",
    license: "MIT",
    desc: "渲染层界面框架",
    url: "https://github.com/facebook/react",
  },
  {
    name: "React DOM",
    version: "19.3.0",
    license: "MIT",
    desc: "React 的浏览器渲染实现",
    url: "https://github.com/facebook/react",
  },
  {
    name: "@ttqtt/liquid-glass-react",
    version: "0.0.2",
    license: "MIT",
    desc: "液态玻璃 UI 组件库（玻璃面板、按钮、卡片、开关、滑动条等全部界面控件）",
    url: "https://github.com/Tsdsj/liquid-glass-react",
  },
  {
    // ⚠️ 两个内核都在分发范围（设置页可自选），一并列出。
    // 版本号必须与 src/fingerprint-browser.js 的 ENGINES 一致（selfcheck 有守卫），
    // 别写旧版本 —— 用户按这里的号去核对下载到的是不是同一个。
    name: "Chromix（fingerprint-chromium）",
    version: "154.0.8037.57",
    license: "BSD-3-Clause",
    desc: "环境拟真增强浏览器内核 · 默认（基于 Ungoogled Chromium），运行时按需下载",
    url: "https://github.com/xiaozhou26/Chromix",
  },
  {
    name: "fingerprint-chromium（备用内核）",
    version: "150.0.7871.186",
    license: "BSD-3-Clause",
    desc: "旧内核 · 保留备用当前不可选（存在 canvas 读像素崩溃缺陷，上游 issue #94 未修）",
    url: "https://github.com/adryfish/fingerprint-chromium",
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

/**
 * 灵感来源 / 致谢：本项目的签到、活动、阅读等接口用法参考了以下作者的脚本。
 * 第一位为原始作者，其后各位在原始版本的基础上继续改进与二次发布。
 */
type CreditLink = { label: string; href: string };
type Credit = {
  key: string;
  name: string;
  initial: string;
  role: string;
  desc: string;
  links: CreditLink[];
};

const CREDITS: Credit[] = [
  {
    key: "geosam",
    name: "潘钜森",
    initial: "潘",
    role: "原始作者",
    desc: "《MS积分商城签到》脚本原作者，本项目的接口调用方式源自他的实现",
    links: [
      { label: "GitHub", href: "https://github.com/geosam/FuckScripts" },
      { label: "ScriptCat", href: "https://scriptcat.org/zh-CN/users/27974" },
    ],
  },
  {
    key: "sdsmalin",
    name: "SDSmalin",
    initial: "S",
    role: "改进版",
    desc: "维护《MS积分商城签到（改进版）》，本项目参考其中的改进实现",
    links: [{ label: "ScriptCat", href: "https://scriptcat.org/zh-CN/users/211564" }],
  },
  {
    key: "dusklight",
    name: "DuskLight",
    initial: "D",
    role: "改进版",
    desc: "发布《MS积分商城签到（改进版）》，本项目参考其活动处理逻辑",
    links: [{ label: "ScriptCat", href: "https://scriptcat.org/zh-CN/users/187483" }],
  },
  {
    key: "withfeel",
    name: "withfeel",
    initial: "W",
    role: "分离获取授权版",
    desc: "发布《MS积分商城签到（改进版）-分离获取授权》，「授权与任务分离」的思路被本项目采用",
    links: [{ label: "ScriptCat", href: "https://scriptcat.org/zh-CN/users/207134" }],
  },
];

/**
 * 友情链接：作者邀请 / 赞助通道 / 公益服务。
 * logo 字段为图片型标识（gh-proxy 的官方 GitHub Mark、hitokoto.cn 官方站点图标），
 * 有 logo 的条目走 <img> 分支；没有的走内联 SVG。
 */
const LINKS: {
  key: string;
  href: string;
  name: string;
  title: string;
  desc: string;
  tint: string;
  logo?: string;
}[] = [
  {
    key: "akile",
    href: "https://akile.ai/register?aff_code=1d7e06e0-2922-457e-bada-f814833f7c40",
    name: "AkileCloud",
    title: "AI 网关 / 云服务",
    desc: "本项目调用其 GPT 系列模型，价格实惠、稳定不降智",
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
  {
    key: "ghproxy",
    href: "https://gh-proxy.com/",
    name: "GitHub加速下载代理",
    title: "GitHub 代理加速",
    desc: "支持API、Git Clone、Releases、Archive、Gist、Raw 文件代理加速下载服务",
    tint: "#24292f",
    logo: "https://r2.gh-proxy.com/GitHub-Mark-ea2971cee799.png",
  },
  {
    key: "hitokoto",
    href: "https://hitokoto.cn/?uuid=c232591b-933d-4301-916a-c026fd39b95c",
    name: "一言 Hitokoto",
    title: "公益一言接口",
    desc: "本软件「每日一言」的句子全部来自它；图标取自 hitokoto.cn 官方站点",
    tint: "#8b3dff",
    logo: "https://hitokoto.cn/favicon.ico",
  },
];

export function About() {
  const { hitokoto } = useAppState();
  const [quoteCopied, setQuoteCopied] = useState(false);

  /* 当前版本号（2026-10-07 改为运行时读取主进程 package.json）。
     之前是自声明的 const APP_VERSION = "0.14.12"（编译期烧进 JS），
     与窗口标题（displayVersion()）分叉——用户实测「标题栏 v0.14.6.1、侧边栏 0.14.5」。
     现在统一问主进程拿真值，取不到时回落编译期常量（预览 / mock）。

     ⚠️ 这段**必须**在组件函数体内。2026-10-07 首次改动时它被误放在模块顶层，
     React 立刻抛 `Cannot read properties of null (reading 'useState')`
     （顶层没有 dispatcher），整棵 App 树不渲染 ⇒ **启动即黑屏**。
     selfcheck 有守卫钉住「顶层不得出现 hook 调用」。 */
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.getRuntimeVersion?.())
      .then((v) => {
        if (alive && v && typeof v.version === "string" && v.version) setAppVersion(v.version);
      })
      .catch(() => {
        /* 预览模式 / IPC 不可用时保留编译期常量 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const onCopy = async (text: string, label: string) => {
    const ok = await copyText(text);
    if (ok) toast.success(`${label}已复制到剪贴板`);
    else toast.error("复制失败，请手动选中链接复制");
  };

  /** 复制当前一言（与界面角落小字点击复制同源） */
  const onCopyQuote = async () => {
    if (!hitokoto) return;
    const ok = await copyText(hitokoto);
    if (ok) {
      setQuoteCopied(true);
      window.setTimeout(() => setQuoteCopied(false), 1600);
    } else {
      toast.error("复制失败，请手动选中复制");
    }
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
            v{appVersion}
          </Tag>
        </div>

        <AppCard padding={16}>
          <div className="about-hero">
            <img className="about-logo" src="./icon.png" alt="" draggable={false} />
            <div style={{ minWidth: 0 }}>
              <div className="about-name">MS Rewards Auto</div>
              <div className="about-ver">版本 v{appVersion} · MIT License</div>
              <div className="hint" style={{ marginTop: 6 }}>
                Electron + Playwright 多账户自动任务工具。本软件为个人学习交流用途的开源项目，
                <b>非MS官方授权产品</b>，与 Microsoft Corporation 无任何关联。
              </div>
            </div>
          </div>
        </AppCard>
      </div>

      {/* ---- 每日一言 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">每日一言</div>
            <div className="block-sub">每 15 秒随机换一句，来自一言公益接口（v1.hitokoto.cn）</div>
          </div>
          {hitokoto && (
            <GlassButton variant="plain" controlSize="small" onClick={() => void onCopyQuote()}>
              {quoteCopied ? "✓ 已复制" : "⧉ 复制"}
            </GlassButton>
          )}
        </div>

        <AppCard padding={16}>
          {hitokoto ? (
            <blockquote className="about-quote">
              <span className="about-quote-mark" aria-hidden="true">
                “
              </span>
              <p className="about-quote-text">{hitokoto}</p>
            </blockquote>
          ) : (
            <div className="hint">
              暂未取到一言。请在「全局设置 → 推送通知」开启「每日一言」；接口不可用时此处留空，不影响其它功能。
            </div>
          )}
          <div className="hint" style={{ marginTop: 12 }}>
            这里展示的与界面角落显示的是同一句（后端 15 秒缓存 + 前端 15 秒轮询）。
            一言内容由公益接口 <a href="https://hitokoto.cn/" target="_blank" rel="noreferrer">hitokoto.cn</a>{" "}
            提供，与本软件无关；可在「全局设置 → 推送通知」里选句子类型。
          </div>
        </AppCard>
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

        <AppCard padding={16}>
          <div className="dep-group-title">直接依赖（随安装包分发）</div>
          <div className="dep-list">
            {DIRECT_DEPS.map((d) => (
              <div
                className="dep-item dep-link"
                key={d.name}
                role="link"
                tabIndex={0}
                title={`打开 ${d.name} 项目主页（${d.url}）`}
                onClick={() => window.open(d.url, "_blank", "noopener")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    window.open(d.url, "_blank", "noopener");
                  }
                }}
              >
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
        </AppCard>
      </div>

      {/* ---- 灵感来源与致谢 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">灵感来源与致谢</div>
            <div className="block-sub">
              本项目的接口用法参考了以下作者的油猴脚本，在此诚挚致谢
            </div>
          </div>
          <Tag size="sm">{CREDITS.length} 位作者</Tag>
        </div>

        <AppCard padding={16}>
          <div className="credit-list">
            {CREDITS.map((c) => (
              <div className="credit-item" key={c.key}>
                <div className={`credit-avatar credit-${c.key}`} aria-hidden="true">
                  {c.initial}
                </div>
                <div className="credit-main">
                  <div className="credit-head">
                    <span className="credit-name">{c.name}</span>
                    <Tag color={c.key === "geosam" ? "accent" : "success"} size="sm">
                      {c.role}
                    </Tag>
                  </div>
                  <div className="credit-desc">{c.desc}</div>
                </div>
                <div className="credit-actions">
                  {c.links.map((l) => (
                    <GlassButton
                      key={l.href}
                      variant="plain"
                      controlSize="small"
                      onClick={() => window.open(l.href, "_blank", "noopener")}
                    >
                      ↗ {l.label}
                    </GlassButton>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="hint" style={{ marginTop: 14 }}>
            以上脚本均服务于 MS Rewards 场景，版权归各自作者所有。本项目仅在接口调用方式上
            参考其实现，未包含其源代码。
          </div>
        </AppCard>
      </div>

      {/* ---- 友情链接 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">友情链接</div>
            <div className="block-sub">实用工具站 + 本项目正在使用的工具与服务；感谢这些工具对本项目的支持</div>
          </div>
        </div>

        <AppCard padding={16}>
          <div className="friend-list">
            {LINKS.map((l) => (
              <div className="friend-item" key={l.key}>
                <GlassSurface className="friend-logo" radius={14}>
                  {l.logo ? (
                    /* 图片型标识（gh-proxy 官方 GitHub Mark / 一言官方 favicon 里的 256px PNG）。
                       ⚠️ 反色滤镜只给 .friend-mark-invert —— 一言是紫色六边形，暗色主题下
                       一起反相会变绿，别再把 invert 挂回 .friend-mark-img 上。 */
                    <img
                      className={`friend-mark friend-mark-img${l.key === "ghproxy" ? " friend-mark-invert" : ""}`}
                      src={l.logo}
                      alt=""
                      draggable={false}
                      loading="lazy"
                    />
                  ) : l.key === "akile" ? (
                    <svg className="friend-mark" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M42.919 11.923L25 1.577a2 2 0 00-2 0L5.081 11.923a2 2 0 00-1 1.732v20.69a2 2 0 001 1.732L23 46.423a2 2 0 002 0l17.919-10.346a2 2 0 001-1.732v-20.69a2 2 0 00-1-1.732zM30.556 9.525L38.5 14 24 23l-13.808-8.668L17.5 10l6.5 4 6.556-4.475zM22 40.441V26.286L8 17.358v7.928l8 5.464v6.227l6 3.464zm10-3.464l-6 3.464V26.286l14-8.928v8.928l-8 5.464v5.227z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    /* WorkBuddy 官方标识（取自官方站点 title SVG 的图形部分，矢量内联）：
                       青绿渐变「圆角方块」底（rx=120.842/560≈22%）+ 白色互锁图形 + 右下暖光。
                       ⚠️ 勿改成 favicon 那版（viewBox 0 0 40 40 / rx=20）——那是正圆底，
                       用户明确要求保持最初的「方的」（0.9.4.11 回退）。图形超出画布属官方
                       原样出血设计，配合 .friend-logo 的 padding:0 居中正常。 */
                    <svg
                      className="friend-mark"
                      viewBox="0 0 560 560"
                      fill="none"
                      aria-hidden="true"
                    >
                      <defs>
                        <linearGradient
                          id="wb-logo-bg"
                          x1="280"
                          y1="0"
                          x2="280"
                          y2="560"
                          gradientUnits="userSpaceOnUse"
                        >
                          <stop stopColor="#0EC8A9" />
                          <stop offset="1" stopColor="#01C886" />
                        </linearGradient>
                        <clipPath id="wb-logo-clip">
                          <rect width="560" height="560" rx="120.842" fill="white" />
                        </clipPath>
                        <filter
                          id="wb-logo-glow"
                          x="132.577"
                          y="276.465"
                          width="668.384"
                          height="668.383"
                          filterUnits="userSpaceOnUse"
                          colorInterpolationFilters="sRGB"
                        >
                          <feFlood floodOpacity="0" result="BackgroundImageFix" />
                          <feBlend
                            mode="normal"
                            in="SourceGraphic"
                            in2="BackgroundImageFix"
                            result="shape"
                          />
                          <feGaussianBlur stdDeviation="77.0026" result="effect1_foregroundBlur" />
                        </filter>
                      </defs>
                      <g clipPath="url(#wb-logo-clip)">
                        <rect width="560" height="560" rx="120.842" fill="url(#wb-logo-bg)" />
                        {/* 右下角暖色柔光 */}
                        <g filter="url(#wb-logo-glow)">
                          <circle
                            cx="466.768"
                            cy="610.657"
                            r="180.186"
                            fill="#FFE355"
                            fillOpacity="0.49"
                          />
                        </g>
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d={"M428.301 43.7869C433.792 38.8624 434.121 38.6717 438.148 38.43C444.672 37.9533 450.647 41.0844 460.819 50.3452C484.581 71.938 517.668 116.33 538.239 154.24L546.186 168.954L557.413 174.534C568.251 180.01 586.031 191.24 593.455 197.262C596.813 200.038 597.284 200.096 600.776 198.737C616.534 192.601 639.106 200.734 659.016 219.835C676.939 237.012 694.103 266.362 700.679 290.858C701.639 294.8 702.915 303.276 703.379 309.588C704.879 331.751 697.772 349.453 684.084 357.466C681.288 359.08 681.101 359.517 681.18 366.49C681.81 399.683 672.863 432.812 654.889 465.122C634.601 501.4 598.474 538.927 549.58 574.284C523.325 593.39 461.207 629.584 433.121 642.29C365.84 672.581 311.905 684.2 265.054 678.46C237.109 675.074 205.479 664.165 186.763 651.503C181.836 648.097 181.056 647.888 177.292 648.965C157.256 654.72 131.017 642.892 108.725 618.148C99.8345 608.257 85.4853 583.972 80.8332 570.976C70.0723 540.561 72.2114 513.116 86.5452 496.725C90.2487 492.503 90.366 492.326 89.5569 485.227C88.2212 473.606 87.6148 456.41 88.2251 445.31L88.7083 434.942L73.1423 407.411C49.0383 364.522 33.7291 328.508 27.8227 300.993C24.7046 285.905 24.8983 279.213 28.7282 274.261C31.059 271.27 38.7024 268.174 47.9183 266.472C71.1183 262.399 121.718 266.084 178.01 276.023L183.858 277.033L196.707 265.667C218.038 246.771 232.21 236.177 258.335 219.887C285.565 202.85 316.296 188.836 350.903 177.739L362.007 174.179L368.108 158.155C389.962 100.466 412.344 57.9349 428.301 43.7869ZM245.248 339.404C220.549 353.664 208.2 360.794 199.126 368.784C162.379 401.142 148.645 452.396 164.289 498.792C168.153 510.249 175.283 522.599 189.543 547.298C203.802 571.996 210.933 584.346 218.923 593.42C251.281 630.167 302.535 643.901 348.932 628.256C360.389 624.393 372.738 617.263 397.437 603.003L539.52 520.972C564.218 506.712 576.568 499.582 585.642 491.591C622.389 459.233 636.122 407.979 620.477 361.583C616.614 350.126 609.484 337.776 595.224 313.077C580.964 288.379 573.834 276.029 565.844 266.955C533.485 230.208 482.233 216.475 435.836 232.119C424.379 235.983 412.029 243.113 387.331 257.373L245.248 339.404Z"}
                          fill="white"
                        />
                        <rect
                          x="258.943"
                          y="438.681"
                          width="56.1265"
                          height="116.57"
                          rx="28.0633"
                          transform="rotate(-30 258.943 438.681)"
                          fill="white"
                        />
                        <rect
                          x="410.373"
                          y="351.252"
                          width="56.1265"
                          height="116.57"
                          rx="28.0633"
                          transform="rotate(-30 410.373 351.252)"
                          fill="white"
                        />
                      </g>
                    </svg>
                  )}
                </GlassSurface>

                <div className="friend-main">
                  <div className="friend-head">
                    <span className="friend-name">{l.name}</span>
                    <Tag
                      color={
                        l.key === "akile" || l.key === "hitokoto"
                          ? "accent"
                          : l.key === "ghproxy"
                            ? "default"
                            : "success"
                      }
                      size="sm"
                    >
                      {l.title}
                    </Tag>
                  </div>
                  <div className="friend-desc">{l.desc}</div>
                  <div className="friend-url" title={l.href}>
                    {l.href}
                  </div>
                </div>

                <div className="friend-actions">
                  {/* 工具站 / 服务站统一用「打开」 */}
                  <GlassButton
                    variant="glass"
                    controlSize="small"
                    onClick={() => window.open(l.href, "_blank", "noopener")}
                  >
                    {"↗ 打开"}
                  </GlassButton>
                  <GlassButton variant="plain" controlSize="small" onClick={() => void onCopy(l.href, l.name)}>
                    ⧉ 复制链接
                  </GlassButton>
                </div>
              </div>
            ))}
          </div>

          <div className="hint" style={{ marginTop: 14 }}>
            以上是本项目正在使用的工具与服务，感谢它们对本项目的支持；其中部分服务带有作者推荐位，
            但作者未从中获得任何收益。工具站与公益站（如 GitHub 加速代理、一言）与作者无利益关系。
          </div>
        </AppCard>
      </div>

      {/* ---- 开源许可摘要 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">开源许可</div>
          </div>
        </div>
        <AppCard padding={16}>
          <div className="hint" style={{ lineHeight: 1.7 }}>
            本软件以 MIT 许可证开源发布，源码托管于 GitHub。软件按「现状」提供，不附带任何
            明示或默示的担保。使用本软件产生的风险由使用者自行承担，请遵守 Microsoft
            服务条款与当地法律法规。
          </div>
          <div className="about-actions">
            <GlassButton variant="glass" controlSize="small"
              onClick={() =>
                window.open("https://github.com/zefeng1236/ms-rewards-auto", "_blank", "noopener")
              }
            >
              ⌘ 项目仓库
            </GlassButton>
            <GlassButton variant="plain" controlSize="small"
              onClick={() =>
                window.open(
                  "https://github.com/zefeng1236/ms-rewards-auto/releases",
                  "_blank",
                  "noopener"
                )
              }
            >
              ↓ 历史版本
            </GlassButton>
          </div>
        </AppCard>
      </div>
    </>
  );
}
