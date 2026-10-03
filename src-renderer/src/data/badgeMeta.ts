/**
 * 勋章元数据（渲染层副本）
 *
 * ⚠️ 这里的 id / name / iconKey / tone 必须与主进程 src/badges.js **逐字段一致**，
 *    但凡改一边忘了改另一边，界面就会出现「拿到勋章却显示成问号」。
 *    selfcheck 里有一条守卫比对两边（scripts/selfcheck.js 搜「勋章元数据」），
 *    改任意一个文件都要跑 `npm run selfcheck`。
 */

export interface BadgeMeta {
  id: string;
  name: string;
  desc: string;
  iconKey: string;
  tone: string;
  /** 连续签到档位（仅 streak 类有） */
  days?: number;
  /** 分组，用于勋章墙分区展示 */
  group: "streak" | "perfect" | "festival";
}

export const BADGE_META: BadgeMeta[] = [
  /* ---- 连续签到 ---- */
  { id: "streak3", name: "连续 3 天", desc: "连续 3 天全部完成", iconKey: "streak3", tone: "cyan", days: 3, group: "streak" },
  { id: "streak7", name: "连续 7 天", desc: "连续 7 天全部完成", iconKey: "streak7", tone: "teal", days: 7, group: "streak" },
  { id: "streak10", name: "连续 10 天", desc: "连续 10 天全部完成", iconKey: "streak10", tone: "green", days: 10, group: "streak" },
  { id: "streak14", name: "连续 14 天", desc: "连续 14 天全部完成", iconKey: "streak14", tone: "amber", days: 14, group: "streak" },
  { id: "streak20", name: "连续 20 天", desc: "连续 20 天全部完成", iconKey: "streak20", tone: "orange", days: 20, group: "streak" },
  { id: "streak28", name: "连续 28 天", desc: "连续 28 天全部完成", iconKey: "streak28", tone: "violet", days: 28, group: "streak" },

  /* ---- 月全勤 ---- */
  { id: "perfectMonth", name: "满月全勤", desc: "一整个月，天天都没落下", iconKey: "perfectMonth", tone: "gold", group: "perfect" },

  /* ---- 中国农历传统节日 ---- */
  { id: "spring", name: "春节", desc: "正月初一，万象更新", iconKey: "spring", tone: "red", group: "festival" },
  { id: "lantern", name: "元宵节", desc: "正月十五，灯火可亲", iconKey: "lantern", tone: "amber", group: "festival" },
  { id: "longtaitou", name: "龙抬头", desc: "二月初二，春回大地", iconKey: "dragon", tone: "teal", group: "festival" },
  { id: "qingming", name: "清明节", desc: "踏青时节，春和景明", iconKey: "qingming", tone: "green", group: "festival" },
  { id: "dragonboat", name: "端午节", desc: "五月初五，粽叶飘香", iconKey: "zongzi", tone: "green", group: "festival" },
  { id: "qixi", name: "七夕节", desc: "七月初七，鹊桥相会", iconKey: "qixi", tone: "violet", group: "festival" },
  { id: "midautumn", name: "中秋节", desc: "八月十五，花好月圆", iconKey: "mooncake", tone: "amber", group: "festival" },
  { id: "chongyang", name: "重阳节", desc: "九月初九，登高望远", iconKey: "chongyang", tone: "amber", group: "festival" },
  { id: "laba", name: "腊八节", desc: "腊月初八，粥暖岁寒", iconKey: "laba", tone: "brown", group: "festival" },
  { id: "chuxi", name: "除夕", desc: "岁除之夜，辞旧迎新", iconKey: "chuxi", tone: "red", group: "festival" },

  /* ---- 公历节日 ---- */
  { id: "newyear", name: "元旦", desc: "一月一日，新年伊始", iconKey: "newyear", tone: "red", group: "festival" },
  { id: "valentine", name: "情人节", desc: "二月十四，心意相通", iconKey: "valentine", tone: "pink", group: "festival" },
  { id: "fool", name: "愚人节", desc: "四月一日，玩笑万岁", iconKey: "fool", tone: "violet", group: "festival" },
  { id: "earth", name: "世界地球日", desc: "四月廿二，守护蓝色星球", iconKey: "earth", tone: "green", group: "festival" },
  { id: "labor", name: "劳动节", desc: "五月一日，致敬耕耘", iconKey: "labor", tone: "amber", group: "festival" },
  { id: "children", name: "儿童节", desc: "六月一日，童心未泯", iconKey: "children", tone: "cyan", group: "festival" },
  { id: "national", name: "国庆节", desc: "十月一日，举国同庆", iconKey: "national", tone: "red", group: "festival" },
  { id: "halloween", name: "万圣节", desc: "十月卅一，南瓜灯的夜晚", iconKey: "halloween", tone: "orange", group: "festival" },
  { id: "thanksgiving", name: "感恩节", desc: "十一月第四个周四", iconKey: "thanksgiving", tone: "brown", group: "festival" },
  { id: "christmas", name: "圣诞节", desc: "十二月廿五，铃儿响叮当", iconKey: "christmas", tone: "red", group: "festival" },
];

export const BADGE_BY_ID: Record<string, BadgeMeta> = Object.fromEntries(
  BADGE_META.map((b) => [b.id, b])
);

/** 按分组取勋章 */
export const badgesOf = (group: BadgeMeta["group"]) => BADGE_META.filter((b) => b.group === group);

/** 每日状态四档的说明（图例用） */
export const STATUS_LEGEND: { key: "done" | "partial" | "idle" | "error"; label: string; cls: string }[] = [
  { key: "done", label: "全部完成", cls: "done" },
  { key: "partial", label: "部分完成", cls: "partial" },
  { key: "idle", label: "未启动", cls: "idle" },
  { key: "error", label: "出错无进度", cls: "error" },
];
