/**
 * 推送版式验收：打桩跑真实 src/notify.js 路径，检查最终正文。
 *
 * 为什么单独一个文件：
 *   推送格式涉及异步拼装（用户名+版本号 / 一言首末行 / 标题下沉），
 *   静态正则只能证明「代码长这样」，证明不了「消息真的是这样」。
 *   这里把 fetch 换成桩、把 storage 指向临时目录，跑真实模块，断言最终报文。
 *
 * 由 scripts/selfcheck.js 调用；也可单独执行：
 *   node scripts/verify-notify-format.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msr-notify-"));

// 桩必须在 require 之前安装：把 hitokoto 的存储目录改到临时目录，不污染用户数据
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent) {
  const pf = parent && parent.filename ? String(parent.filename).replace(/\\/g, "/") : "";
  if (request === "./storage-path" && pf.endsWith("/src/hitokoto.js")) {
    return { resolve: (n) => path.join(tmp, n) };
  }
  return origLoad.apply(this, arguments);
};

const QUOTE = "保持热爱，奔赴山海。 —— 测试出处";
const TITLE = "MS积分任务-搜索";
const pushes = [];
let hitokotoHits = 0;

global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("v1.hitokoto.cn")) {
    hitokotoHits++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ hitokoto: "保持热爱，奔赴山海。", from: "测试出处" }),
      text: async () => "",
    };
  }
  pushes.push({ url: u, body: init && init.body });
  return { ok: true, status: 200, text: async () => '{"errcode":0,"errmsg":"ok"}' };
};

const notify = require(path.join(ROOT, "src", "notify.js"));
const hitokotoMod = require(path.join(ROOT, "src", "hitokoto.js"));
const goals = require(path.join(ROOT, "src", "goals.js"));
const { displayVersion } = require(path.join(ROOT, "src", "version.js"));

const mkCtx = (notice) => ({
  name: "测试账号",
  config: { get: () => ({ notice }) },
  state: { getDateHyphen: () => "2026-01-01" },
});
const mkNotice = (extra = {}) =>
  Object.assign(
    { wework: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TEST", hitokoto: true },
    extra
  );
const body = (i) => JSON.parse(pushes[i].body).text.content;

(async () => {
  await notify.sendText(mkCtx(mkNotice()), TITLE, "已完成 5 次搜索\n获得 30 积分");
  await notify.sendText(mkCtx(mkNotice()), "MS积分任务-阅读", "已完成阅读");
  await notify.sendText(mkCtx(mkNotice({ hitokoto: false })), TITLE, "本次无一言");

  const goalLine = goals.formatLines(
    { enable: true, items: [{ name: "每日", target: 300, scope: "balance" }] },
    { today: 120, balance: 120 }
  )[0];
  await notify.sendSummary(
    mkCtx(mkNotice()),
    ["用户名：测试账号", "今日获得：30 积分", "", goalLine].join("\n")
  );

  const ver = displayVersion();
  const head = `用户名：测试账号　　v${ver}`;
  const bad = [];
  const l1 = body(0).split("\n");

  // ① 版式：一言 → 标题（下沉） → 用户名+版本号 → 正文 → 空行 → 一言
  if (l1[0] !== QUOTE) bad.push(`第一行不是一句话（实际：${l1[0]}）`);
  if (l1[1] !== TITLE) bad.push("标题没有下沉到一句话之下");
  if (l1[2] !== head) bad.push(`第三行不是用户名+版本号（实际：${l1[2]}）`);
  if (!/\n\n保持热爱，奔赴山海。 —— 测试出处$/.test(body(0))) bad.push("末尾缺「空一行 + 一句话」");
  if ((body(0).match(/保持热爱/g) || []).length !== 2) bad.push("一句话应首尾各一次");

  // ② 缓存策略：30 秒 TTL + 推送强制刷新
  //    - 推送走 force：每次推送各请求一次新句（上面 3 条开启一言的推送 = 3 次）
  //    - 界面走默认：TTL 内复用，连续两次调用只应请求一次
  const hitsBefore = hitokotoHits;
  if (hitsBefore !== 3) bad.push(`推送应各 force 请求一次新句，实际 ${hitsBefore} 次（期望 3）`);

  const ui1 = await hitokotoMod.get();
  const hitsAfterUi1 = hitokotoHits;
  await hitokotoMod.get();
  await hitokotoMod.get();
  // 界面首次调用时缓存刚被推送刷新过（未过 30 秒 TTL），不应再请求
  if (hitokotoHits !== hitsAfterUi1) bad.push("界面在同一 TTL 窗口内重复请求了接口");
  if (!ui1 || !ui1.text) bad.push("界面取不到一言");

  await hitokotoMod.get({ force: true });
  if (hitokotoHits !== hitsAfterUi1 + 1) bad.push("get({force:true}) 未跳过 TTL 缓存");

  // ③ 关闭一言：不带一言，也不留多余空行
  if (/保持热爱/.test(body(2))) bad.push("关闭一言后仍带一句话");
  if (body(2).trimEnd() !== `${TITLE}\n${head}\n本次无一言`) bad.push("关闭一言后版式异常");

  // ④ 汇总：标题不合进正文，但一言仍须在首行与末行（且要走 force 刷新）
  const sl = body(3).split("\n");
  if (sl[0] !== QUOTE) bad.push(`汇总第一行不是一句话（实际：${sl[0]}）`);
  if (!/\n\n保持热爱，奔赴山海。 —— 测试出处$/.test(body(3))) bad.push("汇总末尾缺「空一行 + 一句话」");
  if (sl.filter((x) => x.startsWith("用户名：")).length !== 1) bad.push("汇总用户名行重复或缺失");
  if (!sl.includes(head)) bad.push("汇总缺用户名+版本号行");
  if (!sl.some((x) => x.startsWith("🏅 "))) bad.push("汇总目标行缺勋章图标");

  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad.length) {
    console.log("❌ 推送版式验收未通过：");
    bad.forEach((b) => console.log("   - " + b));
    process.exit(1);
  }
  console.log("✅ 推送版式验收通过（一句话首行/标题下沉/版本号/末行空一行/目标勋章，均经真实路径）");
})().catch((e) => {
  console.error("运行异常:", e);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
