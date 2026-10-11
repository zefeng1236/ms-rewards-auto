/**
 * 汇总报告的发送出口：两种方式，按配置选。
 *
 * 【为什么要两种】
 *   · notice —— 复用「推送通知」里已经配好的 webhook。用户**多半已经配好了**
 *     钉钉/企微/飞书 webhook（不然他收不到每日汇总），所以这是最省事的路：
 *     不用再申请企业内部应用、不用找群ID，勾一下就能用。
 *   · app   —— 用企业内部应用机器人 groupMessages/send。适合想用独立的
 *     「统计机器人」、不想让统计和每日汇总混在同一条消息流里的场景。
 *     代价是要配 Client ID/Secret + 群ID。
 *
 * 默认走 notice —— 让功能**开箱即用**比给用户多三个待填项重要得多。
 */

const logger = require("./logger");
const globalConfig = require("./global-config");
const notify = require("./notify");
const dingApp = require("./dingtalk-app");

/**
 * 发送汇总报告。
 *
 * @param {object} report
 * @param {string} report.title 标题
 * @param {string} report.text  markdown 正文
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
 */
async function sendReport(report) {
  const cfg = (globalConfig.get() || {}).cluster || {};
  const via = String(cfg.reportVia || "notice");

  if (via === "app") {
    return sendViaApp(cfg, report);
  }
  return sendViaNotice(report);
}

/** 走「推送通知」里已配好的 webhook（复用 notify 的拼装与重试逻辑） */
async function sendViaNotice(report) {
  const notice = (globalConfig.get() || {}).notice || {};
  // 复用 notify.sendTitleText：它与每日汇总走**同一套版式与通道**，
  // 不会出现「统计报告版式跟别的不一样」这种割裂感。
  try {
    const r = await notify.sendTitleText(notice, report.title, report.text);
    if (!r || r.ok === false) {
      const err = (r && r.error) || "推送通道未配置或全部失败";
      return { ok: false, via: "notice", error: err };
    }
    return { ok: true, via: "notice" };
  } catch (e) {
    return { ok: false, via: "notice", error: e && e.message ? e.message : String(e) };
  }
}

/** 走企业内部应用机器人（groupMessages/send） */
async function sendViaApp(cfg, report) {
  const r = await dingApp.sendGroupMarkdown(cfg, report.title, report.text);
  if (!r.ok) return { ok: false, via: "app", error: r.error };
  return { ok: true, via: "app" };
}

/**
 * 自检：把当前配置的发送方式验证一遍（不发真消息给群，尽量少打扰）。
 *
 * @returns {Promise<{ok:boolean, via:string, error?:string, note?:string}>}
 */
async function testSend() {
  const cfg = (globalConfig.get() || {}).cluster || {};
  const via = String(cfg.reportVia || "notice");

  if (via === "app") {
    // 企业机器人：只验能不能换到 token + 有没有群ID，
    // **不真往群里发** —— 测试消息会打扰所有人，而绝大多数失败
    // （密钥错、没群ID）不靠"发一条"也能查出来。
    const r = await dingApp.testConnection(cfg);
    if (!r.ok) return { ok: false, via, error: r.error };
    if (!r.hasConversation) {
      return {
        ok: false,
        via,
        error: "Client ID/Secret 有效，但还没填群ID（openConversationId）",
        note: "群ID 在钉钉群「群设置 → 机器人」或通过 JSAPI 获取",
      };
    }
    return { ok: true, via, note: `凭据有效（token ${r.tokenMasked}），群ID 已配置` };
  }

  // notice：真发一条，因为这是用户点「测试」时的预期 —— 他要看到群里有反应，
  // 否则没法确认到底通没通。标题写明是测试，避免误会。
  const notice = (globalConfig.get() || {}).notice || {};
  try {
    const r = await notify.testPush(notice, "汇总通道");
    if (!r || !r.ok) {
      return { ok: false, via, error: `没有成功的通道（成功 ${(r && r.okCount) || 0}/${(r && r.total) || 0}）` };
    }
    return { ok: true, via, note: `已发送测试消息（成功 ${r.okCount}/${r.total} 个通道）` };
  } catch (e) {
    return { ok: false, via, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { sendReport, testSend };
