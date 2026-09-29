import { useId } from "react";

/**
 * 勋章图形：27 枚，每枚造型独立。
 *
 * 设计约束：
 *   - 统一 32×32 viewBox，底盘是半透明渐变圆 —— 与液态玻璃的通透感一致；
 *   - 主色一律用**浅调**（暗色界面上不发闷），深色主题下也看得清；
 *   - 图形走「剪影 + 少量描边」，不在小尺寸上堆细节（16px 徽标会糊）。
 */

/** 色调 → [起始色, 结束色]，全部浅调 */
const TONE: Record<string, [string, string]> = {
  red: ["#ff9d8f", "#ff6b7f"],
  amber: ["#ffdc7a", "#f7b04a"],
  green: ["#a9e6a0", "#57c07a"],
  teal: ["#8ee3d4", "#3cbfa9"],
  cyan: ["#9ae6f7", "#45b6d2"],
  violet: ["#cab7f6", "#8b78dd"],
  orange: ["#ffc491", "#ff8e5c"],
  pink: ["#ffb6cf", "#f76f9f"],
  brown: ["#d8b49c", "#a9805f"],
  gold: ["#ffe694", "#f0be3c"],
};

const FALLBACK: [string, string] = ["#c9d3e0", "#8d9bad"];

export type BadgeTone = keyof typeof TONE | string;

interface Props {
  iconKey: string;
  tone?: BadgeTone;
  size?: number;
  /** 未获得的勋章：灰度 + 降低不透明度 */
  dim?: boolean;
  title?: string;
}

/** 渐变底盘：id 用 useId 保证同页多处渲染不串色 */
function Plate({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <>
      <defs>
        <radialGradient id={id} cx="35%" cy="28%" r="78%">
          <stop offset="0%" stopColor={from} stopOpacity="0.95" />
          <stop offset="100%" stopColor={to} stopOpacity="0.72" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id})`} />
      {/* 顶部高光弧，模拟玻璃折射 */}
      <path d="M6 11a11 11 0 0 1 20 0" fill="none" stroke="#fff" strokeOpacity="0.42" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="0.8" />
    </>
  );
}

const S = { fill: "none", stroke: "#fff", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const W = { fill: "#fff", fillOpacity: 0.92 };

/** 各勋章的内部图形（画在 32×32 底盘之上） */
function Glyph({ iconKey }: { iconKey: string }) {
  switch (iconKey) {
    /* ---------------- 连续签到：造型随天数递进 ---------------- */
    // 三日：三片新芽
    case "streak3":
      return (
        <g>
          <path d="M16 25V14" {...S} />
          <path d="M16 18c-3 0-5-2-5-5 3 0 5 2 5 5z" {...W} />
          <path d="M16 17c0-3 2-5 5-5 0 3-2 5-5 5z" {...W} />
          <circle cx="16" cy="13" r="2" {...W} />
        </g>
      );
    // 七日：一周闭环 + 中心点
    case "streak7":
      return (
        <g>
          <circle cx="16" cy="16" r="8" {...S} strokeOpacity="0.55" />
          <circle cx="16" cy="16" r="3" {...W} />
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <circle key={a} cx={16 + 8 * Math.cos((a * Math.PI) / 180)} cy={16 + 8 * Math.sin((a * Math.PI) / 180)} r="1.5" {...W} />
          ))}
        </g>
      );
    // 旬日：双环十字
    case "streak10":
      return (
        <g>
          <circle cx="16" cy="16" r="9" {...S} strokeOpacity="0.5" />
          <circle cx="16" cy="16" r="4.5" {...S} />
          <path d="M16 5.5v3M16 23.5v3M5.5 16h3M23.5 16h3" {...S} />
        </g>
      );
    // 双周：两个交叠环
    case "streak14":
      return (
        <g>
          <circle cx="12.5" cy="16" r="7" {...S} strokeOpacity="0.75" />
          <circle cx="19.5" cy="16" r="7" {...S} strokeOpacity="0.75" />
        </g>
      );
    // 廿日：烛火
    case "streak20":
      return (
        <g>
          <path d="M16 6c3 4 5 6 5 9a5 5 0 0 1-10 0c0-3 2-5 5-9z" {...W} />
          <path d="M16 12c1.4 2 2.4 3.2 2.4 4.8a2.4 2.4 0 0 1-4.8 0c0-1.6 1-2.8 2.4-4.8z" fill="#ff8e5c" fillOpacity="0.55" />
          <path d="M11 25h10" {...S} />
        </g>
      );
    // 廿八：星宿（北斗式连线）
    case "streak28":
      return (
        <g>
          <path d="M8 21l3.5-6 3 3 3-8 3 7 3.5-3" {...S} strokeOpacity="0.6" />
          {[[8, 21], [11.5, 15], [14.5, 18], [17.5, 10], [20.5, 17], [24, 14]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" {...W} />
          ))}
        </g>
      );
    // 满月全勤：满月 + 桂冠
    case "perfectMonth":
      return (
        <g>
          <circle cx="16" cy="16" r="7.5" {...W} fillOpacity="0.55" />
          <path d="M7 20c-1-4 2-9 6-11M25 20c1-4-2-9-6-11" {...S} />
          <path d="M16 22.5v3M10 24l-1.5 2.5M22 24l1.5 2.5" {...S} />
        </g>
      );

    /* ---------------- 中国农历节日 ---------------- */
    // 春节：红包
    case "spring":
      return (
        <g>
          <rect x="9" y="8" width="14" height="17" rx="2.5" {...W} fillOpacity="0.55" />
          <path d="M9 13h14" {...S} />
          <circle cx="16" cy="13" r="2.2" {...W} />
          <path d="M16 17.5v3M14 19h4" {...S} />
        </g>
      );
    // 元宵：灯笼
    case "lantern":
      return (
        <g>
          <path d="M16 7v3" {...S} />
          <ellipse cx="16" cy="16" rx="6.5" ry="7" {...W} fillOpacity="0.55" />
          <path d="M11 11h10M11 21h10" {...S} strokeOpacity="0.7" />
          <path d="M14 24v2M18 24v2" {...S} />
        </g>
      );
    // 龙抬头：龙首侧影
    case "dragon":
      return (
        <g>
          <path d="M9 21c1-6 5-11 12-11-3 1-5 3-6 6 3-1 5 0 6 2-3 0-5 1-6 3" {...S} />
          <path d="M11 13l-2-3 4 1" {...S} />
          <circle cx="21" cy="13" r="1.3" {...W} />
        </g>
      );
    // 清明：柳枝与雨
    case "qingming":
      return (
        <g>
          <path d="M16 7v10" {...S} />
          <path d="M16 11c-2 1-3 3-3 5M16 14c2 1 3 3 3 5" {...S} strokeOpacity="0.75" />
          <path d="M10 22l-1.5 3M14 23l-1.5 3M18 22l-1.5 3M22 21l-1.5 3" {...S} strokeOpacity="0.6" />
        </g>
      );
    // 端午：粽子
    case "zongzi":
      return (
        <g>
          <path d="M16 8l7 12H9l7-12z" {...W} fillOpacity="0.55" />
          <path d="M9 20h14" {...S} />
          <path d="M16 8v12" {...S} strokeOpacity="0.65" />
        </g>
      );
    // 七夕：双星与鹊桥
    case "qixi":
      return (
        <g>
          <circle cx="10" cy="12" r="2.6" {...W} />
          <circle cx="22" cy="12" r="2.6" {...W} />
          <path d="M6 20c3-3 7-3 10 0s7 3 10 0" {...S} />
          <path d="M6 23.5c3-3 7-3 10 0s7 3 10 0" {...S} strokeOpacity="0.5" />
        </g>
      );
    // 中秋：月饼
    case "mooncake":
      return (
        <g>
          <circle cx="16" cy="16" r="8" {...W} fillOpacity="0.5" />
          <circle cx="16" cy="16" r="8" {...S} strokeOpacity="0.7" />
          <path d="M13 13h6v6h-6z" {...S} strokeOpacity="0.8" />
          <path d="M16 10.5v2.5M16 19v2.5M10.5 16H13M19 16h2.5" {...S} strokeOpacity="0.55" />
        </g>
      );
    // 重阳：登高（山与茱萸）
    case "chongyang":
      return (
        <g>
          <path d="M6 23l6-9 4 5 3-4 7 8H6z" {...W} fillOpacity="0.5" />
          <circle cx="19" cy="9" r="2" {...W} />
          <path d="M19 11v2" {...S} strokeOpacity="0.7" />
        </g>
      );
    // 腊八：粥碗与热气
    case "laba":
      return (
        <g>
          <path d="M8 15h16c0 5-3.5 8-8 8s-8-3-8-8z" {...W} fillOpacity="0.5" />
          <path d="M7 15h18" {...S} />
          <path d="M13 11c-1-1 1-2 0-3M19 11c-1-1 1-2 0-3" {...S} strokeOpacity="0.65" />
        </g>
      );
    // 除夕：爆竹烟花
    case "chuxi":
      return (
        <g>
          <path d="M16 6v6M16 26v-4M7 16h5M20 16h5M10 10l3.5 3.5M21.5 18.5L25 22M22 10l-3.5 3.5M10.5 18.5L7 22" {...S} />
          <circle cx="16" cy="16" r="3" {...W} />
        </g>
      );

    /* ---------------- 公历节日 ---------------- */
    // 元旦：日历页
    case "newyear":
      return (
        <g>
          <rect x="8" y="9" width="16" height="15" rx="2.5" {...W} fillOpacity="0.5" />
          <path d="M8 13h16" {...S} />
          <path d="M12 7v3M20 7v3" {...S} />
          <path d="M14 18l2-2 2 2v3h-4v-3z" {...W} />
        </g>
      );
    // 情人节：双心
    case "valentine":
      return (
        <g>
          <path d="M16 24c-4-3-7-6-7-9.5A3.5 3.5 0 0 1 16 12a3.5 3.5 0 0 1 7 2.5c0 3.5-3 6.5-7 9.5z" {...W} fillOpacity="0.62" />
          <path d="M10 12c-1.5-1-3.5 0-3.5 2 0 2 2 3.5 3.5 5" {...S} strokeOpacity="0.7" />
        </g>
      );
    // 愚人节：小丑帽
    case "fool":
      return (
        <g>
          <path d="M16 7l7 12H9l7-12z" {...W} fillOpacity="0.55" />
          <circle cx="16" cy="7.5" r="1.8" {...W} />
          <path d="M10 22c2 2 10 2 12 0" {...S} />
          <circle cx="13" cy="18" r="1.1" {...W} />
          <circle cx="19" cy="18" r="1.1" {...W} />
        </g>
      );
    // 地球日：地球
    case "earth":
      return (
        <g>
          <circle cx="16" cy="16" r="8.5" {...W} fillOpacity="0.42" />
          <circle cx="16" cy="16" r="8.5" {...S} strokeOpacity="0.7" />
          <path d="M7.5 16h17M16 7.5c3 2.5 3 14 0 17M16 7.5c-3 2.5-3 14 0 17" {...S} strokeOpacity="0.55" />
        </g>
      );
    // 劳动节：齿轮
    case "labor":
      return (
        <g>
          <circle cx="16" cy="16" r="5" {...W} fillOpacity="0.5" />
          <circle cx="16" cy="16" r="2" fill="#5b6472" fillOpacity="0.45" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <path key={a} d="M16 8.5v-2.5" transform={`rotate(${a} 16 16)`} {...S} />
          ))}
        </g>
      );
    // 儿童节：气球
    case "children":
      return (
        <g>
          <ellipse cx="16" cy="13" rx="5.5" ry="6.5" {...W} fillOpacity="0.55" />
          <path d="M16 19.5c0 2-2 3-4 4.5" {...S} />
          <path d="M14.5 8.5c-1-1-2.5-1-3.5 0" {...S} strokeOpacity="0.6" />
        </g>
      );
    // 国庆：旗帜与星
    case "national":
      return (
        <g>
          <path d="M9 7v19" {...S} />
          <path d="M9 9c6-2 10 2 15 0v7c-5 2-9-2-15 0V9z" {...W} fillOpacity="0.55" />
          <path d="M13.5 12l.9 1.9 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z" {...W} />
        </g>
      );
    // 万圣节：南瓜灯
    case "halloween":
      return (
        <g>
          <ellipse cx="16" cy="18" rx="9" ry="7.5" {...W} fillOpacity="0.55" />
          <path d="M16 10.5v-2" {...S} />
          <path d="M11.5 17l2-2 2 2M17.5 17l2-2 2 2" {...S} />
          <path d="M12 21c1.5 1.5 6.5 1.5 8 0" {...S} />
        </g>
      );
    // 感恩节：玉米
    case "thanksgiving":
      return (
        <g>
          <path d="M16 8c3 3 4 8 3 12-1 4-3 5-3 5s-2-1-3-5c-1-4 0-9 3-12z" {...W} fillOpacity="0.55" />
          <path d="M13 25c0-3 1-6 3-8M19 25c0-3-1-6-3-8" {...S} strokeOpacity="0.7" />
          <path d="M16 10v14" {...S} strokeOpacity="0.4" />
        </g>
      );
    // 圣诞：圣诞树
    case "christmas":
      return (
        <g>
          <path d="M16 6l5 7h-10l5-7z" {...W} fillOpacity="0.6" />
          <path d="M16 12l6 8H10l6-8z" {...W} fillOpacity="0.45" />
          <path d="M16 25v-5M13 25h6" {...S} />
          <circle cx="16" cy="5" r="1.5" {...W} />
        </g>
      );

    default:
      return <circle cx="16" cy="16" r="6" {...W} fillOpacity="0.5" />;
  }
}

export function BadgeIcon({ iconKey, tone = "cyan", size = 28, dim = false, title }: Props) {
  const uid = useId().replace(/:/g, "");
  const [from, to] = TONE[tone] || FALLBACK;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{
        display: "block",
        flex: "0 0 auto",
        filter: dim ? "grayscale(0.85)" : undefined,
        opacity: dim ? 0.42 : 1,
      }}
    >
      {title ? <title>{title}</title> : null}
      <Plate id={`bp${uid}`} from={from} to={to} />
      <Glyph iconKey={iconKey} />
    </svg>
  );
}
