/**
 * 生成净化版每日活动测试样本 selfcheck-fixtures/home.json
 * 数据来源：2026-09-14 真实抓取的 rewards.bing.com 首页 dailySetItems，
 * 已将 sid（搜索会话标识）替换为固定假值，无任何登录凭据/Cookie。
 * 供 scripts/selfcheck.js 第 2 节使用，替代原来的整页 HTML 快照。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const outDir = path.join(ROOT, "selfcheck-fixtures");
fs.mkdirSync(outDir, { recursive: true });

// 结构复刻真实 dailySetItems（3 条，对应 2026-09-14 每日活动）
// 字段与 src/tasks.js 解析逻辑对齐：offerId / date / points / hash / destination / isCompleted
const dailySetItems = [
  {
    offerId: "Gamification_DailySet_ZHCN_20260914_Child1",
    date: "09/14/2026",
    points: 10,
    hash: "f1xtZGVmYXVsdEhhc2g==",
    destination:
      "https://www.bing.com/search?q=%e5%8c%97%e4%ba%ac%e4%b9%8b%e6%97%85&FORM=tgrew4&filters=sid%3A%2200000000-0000-4000-8000-000000000000%22+BTEPOKey%3A%22REWARDSQUIZ_DailySet_UrlOffer%22+BTDSUOID%3A%22Gamification_DailySet_ZHCN_20260914_Child1%22&rnoreward=1",
    isCompleted: false,
  },
  {
    offerId: "Gamification_DailySet_ZHCN_20260914_Child2",
    date: "09/14/2026",
    points: 10,
    hash: "f2xtZGVmYXVsdEhhc2g==",
    destination:
      "https://www.bing.com/search?q=%e8%8a%9d%e5%8a%a0%e5%93%a5%e4%b9%8b%e6%97%85&FORM=tgrew4&filters=sid%3A%2211111111-1111-4111-8111-111111111111%22&rnoreward=1",
    isCompleted: false,
  },
  {
    offerId: "Gamification_DailySet_ZHCN_20260914_Child3",
    date: "09/14/2026",
    points: 10,
    hash: "f3xtZGVmYXVsdEhhc2g==",
    destination:
      "https://www.bing.com/search?q=%e5%8e%9f%e5%a3%b0%e5%90%89%e4%bb%96%e4%b9%90%e5%99%a8&form=ML2G76&OCID=ML2G76&PUBL=RewardsDO&CREA=ML2G76&rnoreward=1",
    isCompleted: false,
  },
];

const out = {
  _note: "净化测试样本：结构来自 2026-09-14 真实抓取，sid 已替换为假值，无凭据。",
  dailySetItems,
};

fs.writeFileSync(path.join(outDir, "home.json"), JSON.stringify(out, null, 2));
console.log("已生成", path.join(outDir, "home.json"));
console.log("条目数:", dailySetItems.length);
