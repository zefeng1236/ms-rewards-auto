/**
 * 推送版式验收：打桩跑真实 src/notify.js 路径，检查最终正文。
 *
 * 为什么单独一个文件：
 *   推送格式涉及异步拼装（用户名+版本号 / 一言末行 / 标题是否下沉），
 *   静态正则只能证明「代码长这样」，证明不了「消息真的是这样」。
 *   这里把 fetch 换成桩、把 storage 指向临时目录，跑真实模块，断言最终报文。
 *
 * 版式口径（0.13.10.1 修正版）：
 *   普通推送：标题 → 用户名+版本号 → 正文 → 空行 → 一言
 *   每日汇总：用户名+版本号 → 正文 → 空行 → 一言（标题不合进正文）
 *   一言**固定末行**，首行永远留给标题/用户名。
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
// markdown 剥标记（断言比对纯文本时用，避免在脚本里写字面量加粗标记）
const md = require(path.join(ROOT, "src", "notify-markdown.js"));
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
    // ⚠️ 0.14.14 起推送侧的一言开关改名为 hitokotoInPush（原来的 hitokoto 拆成了
    //    「界面显示」= appearance.hitokoto 与「推送附加」= notice.hitokotoInPush）。
    //    这里必须用新字段名，写旧名会被当成"没传"→ 兜底成 true → 关闭一言语义失效。
    //
    // ⚠️ weworkMarkdown: true 是**显式开启**的：企微默认已改成纯文本（转发微信可读），
    //    而本脚本断言的是 markdown 版式（标题层级、列表、空行分段），
    //    所以必须打开才能验到。纯文本分支另有单独断言（见文件末尾）。
    {
      wework: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TEST",
      hitokotoInPush: true,
      weworkMarkdown: true,
    },
    extra
  );
/**
 * 取第 i 条推送的 markdown 报文。
 *
 * ⚠️ 2026-10-08 起改用 markdown 消息体，字段名与旧的 `text.content` 不同：
 *   - 企业微信：markdown.content（标题由 notify 拼在正文首行）
 *   - 钉钉：markdown.text（标题走markdown.title）
 *   - 飞书：card.elements[0].content（标题走 card.header.title）
 * 本脚本只接了企业微信通道，所以读 markdown.content。
 */
const body = (i) => {
  const b = JSON.parse(pushes[i].body);
  return b.markdown ? String(b.markdown.content || b.markdown.text || "") : "";
};

(async () => {
  await notify.sendText(mkCtx(mkNotice()), TITLE, "已完成 5 次搜索\n获得 30 积分");
  await notify.sendText(mkCtx(mkNotice()), "MS积分任务-阅读", "已完成阅读");
  await notify.sendText(mkCtx(mkNotice({ hitokotoInPush: false })), TITLE, "本次无一言");

  const goalLine = goals.formatLines(
    { enable: true, items: [{ name: "每日", target: 300, scope: "balance" }] },
    { today: 120, balance: 120 }
  )[0];
  await notify.sendSummary(
    mkCtx(mkNotice()),
    ["用户名：测试账号", "今日获得：30 积分", "", goalLine].join("\n")
  );

  const ver = displayVersion();
  // 运行环境后缀（PC / Docker）由 notify.runtimeTag() 判定，这里直接复用，
  // 避免脚本里再写一份判定逻辑导致两处漂移（2026-10-03 新增端标识）。
  const head = `用户名：测试账号　　v${ver}(${notify.runtimeTag()})`;
  const bad = [];
  // 剥掉 markdown 标记后比对纯文本：断言里**不写字面量加粗标记**——
  // 它和后续字符可能凑出块注释结束符（本项目已踩4 次）。
  // 三家渲染结果一致（列表项前缀会被剥掉），所以同一套断言通吃三家。
  // ⚠️ 分隔用的是**两个半角空格**（2026-10-09 起）：全角空格在钉钉窄屏会把
  //    版本号挤到下一行，看着像断了。
  const headPlain = `用户名：测试账号  v${ver}(${notify.runtimeTag()})`;
  /** 剥标记 + 过滤空行：版式只关心内容顺序，空行另有单独断言 */
  const plainLines = (i) =>
    md.stripMarksKeepLines(body(i))
      .split("\n")
      .filter((x) => x.trim() !== "");

  // ① 版式（2026-10-08 markdown 版）：
  //    企业微信没有独立 title 字段，标题以加粗行放在正文最前；
  //    钉钉/飞书把标题放进各自的 title / header，正文里不再重复。
  //    之后依次是「用户名+版本号 → 内容 → 空行 → 一言」。
  //    用户名必须在最前 —— 多账户场景一眼看出推送来自哪个账号，
  //    绝不能被一句话挤走（0.13.10.1 曾短暂改成首行一言，属回归）。
  const l1raw = md.stripMarksKeepLines(body(0)).split("\n");
  if (l1raw[0] !== TITLE) bad.push(`正文首行不是标题（实际：${l1raw[0]}）`);
  // 用户名行之后是分割线（---），它**不属于内容行**，比对时要跳过
  const l1 = plainLines(0).slice(1).filter((x) => x.trim() !== "---");
  if (l1[0] !== headPlain) bad.push(`第一行不是用户名+版本号（实际：${l1[0]}）`);
  if (l1[1] !== "已完成 5 次搜索") bad.push(`第二行不是内容（实际：${l1[1]}）`);
  // 分割线必须在用户名行**之后**、正文之前（否则「谁发的」和「发了什么」又糊一起）
  {
    const raw = plainLines(0);
    const iHead = raw.indexOf(headPlain);
    const iHr = raw.indexOf("---");
    if (iHr < 0) bad.push("用户名行与正文之间缺分割线");
    else if (iHead >= 0 && iHr !== iHead + 1) bad.push("分割线不在用户名行之后");
  }
  if (!/\n\n保持热爱，奔赴山海。 —— 测试出处$/.test(body(0))) bad.push("末尾缺「空一行 + 一句话」");
  // 一言只在末行出现一次：首行若也出现，说明又退回了「首末各一次」的旧版式
  if ((body(0).match(/保持热爱/g) || []).length !== 1) bad.push("一句话应只在末行出现一次");
  if (/保持热爱/.test(l1[0]) || /保持热爱/.test(l1[1])) bad.push("一句话不该出现在首行/第二行");
  // ① b 段落之间必须有空行：三家 markdown 都不认单个换行符（会糊成一段）
  if (!/\n\n/.test(body(0)) && /\n/.test(body(0))) bad.push("正文有换行但无空行分段");
  // ① c 必须是 markdown 消息体（不再是纯text）
  if (JSON.parse(pushes[0].body).msgtype !== "markdown") bad.push("企业微信应发 markdown 消息体");

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
  {
    const noQuote = md
      .stripMarksKeepLines(body(2))
      .split("\n")
      .filter((x) => x.trim() !== "" && x.trim() !== "---");
    if (noQuote.slice(1).join("\n") !== headPlain + "\n本次无一言") bad.push("关闭一言后版式异常");
  }

  // ④ 汇总：首行是「用户名+版本号」（不是一言），一言在末行
  const sl = md.stripMarksKeepLines(body(3)).split("\n");
  // 汇总里用户名行后面同样跟分割线，比对时跳过
  if (sl.filter((x) => x.trim() !== "" && x.trim() !== "---")[1] !== headPlain) bad.push("汇总用户名行位置不对");
  if (!/\n\n保持热爱，奔赴山海。 —— 测试出处$/.test(body(3))) bad.push("汇总末尾缺「空一行 + 一句话」");
  if (sl.filter((x) => x.indexOf("用户名") >= 0).length !== 1) bad.push("汇总用户名行重复或缺失");
  if (!sl.some((x) => x.startsWith("🏅 "))) bad.push("汇总目标行缺勋章图标");

  // ⑤ 企业微信默认走**纯文本**（可转发到微信，微信不支持 markdown）：
  //    报文必须是 msgtype=text，且正文里不该残留任何 markdown 标记。
  //    这里特意用「不传 weworkMarkdown」的配置（模拟老配置/默认配置）来验。
  const plainNotice = Object.assign(
    { wework: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TEST", hitokotoInPush: true }
  );
  const plainReqs = notify.buildRequests(plainNotice, TITLE, "已完成 5 次搜索\n获得 30 积分");
  const plainBody = JSON.parse(plainReqs[0].init.body);
  if (plainBody.msgtype !== "text") bad.push(`企微默认应为纯文本，实际 msgtype=${plainBody.msgtype}`);
  const plainText = String((plainBody.text && plainBody.text.content) || "");
  if (!plainText.startsWith(TITLE)) bad.push("企微纯文本：标题应在正文首行");
  // 残留标记检测：连续两个星号 / 反引号 / 列表符开头 —— 出现在纯文本里就是脏的
  if (/[*]{2}/.test(plainText)) bad.push("企微纯文本残留加粗标记 **");
  if (/`/.test(plainText)) bad.push("企微纯文本残留反引号 `");
  if (/^- /m.test(plainText)) bad.push("企微纯文本残留列表符 - ");
  if (!/\n/.test(plainText)) bad.push("企微纯文本丢了换行（正文会糊成一整段）");

  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad.length) {
    console.log("❌ 推送版式验收未通过：");
    bad.forEach((b) => console.log("   - " + b));
    process.exit(1);
  }
  console.log("✅ 推送版式验收通过（标题在前/用户名+版本号/末行空一行一言/目标勋章，均经真实路径）");
})().catch((e) => {
  console.error("运行异常:", e);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
