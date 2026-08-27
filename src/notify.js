const logger = require("./logger");

/**
 * 发送文本通知（多通道）
 * @param {object} ctx 账户上下文
 * @param {string} title
 * @param {string} text
 */
async function sendText(ctx, title, text) {
  const cfg = ctx.config.get();
  const notice = cfg.notice || {};
  const content = `${title}\n${text}`;
  const jobs = [];

  if (notice.wework) {
    jobs.push(
      fetch(notice.wework, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
        signal: AbortSignal.timeout(8000),
      }).then((r) => logger.ok(`企业微信推送: HTTP ${r.status}`)).catch((e) => logger.warn(`企业微信推送失败: ${e.message}`))
    );
  }
  if (notice.dingding) {
    jobs.push(
      fetch(notice.dingding, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
        signal: AbortSignal.timeout(8000),
      }).then((r) => logger.ok(`钉钉推送: HTTP ${r.status}`)).catch((e) => logger.warn(`钉钉推送失败: ${e.message}`))
    );
  }
  if (notice.feishu) {
    jobs.push(
      fetch(notice.feishu, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text: content } }),
        signal: AbortSignal.timeout(8000),
      }).then((r) => logger.ok(`飞书推送: HTTP ${r.status}`)).catch((e) => logger.warn(`飞书推送失败: ${e.message}`))
    );
  }
  if (notice.pushme) {
    jobs.push(
      fetch(`https://push.i-i.me/get.php?push_key=${encodeURIComponent(notice.pushme)}&title=${encodeURIComponent(title)}&content=${encodeURIComponent(text)}`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      }).then((r) => logger.ok(`PushMe 推送: HTTP ${r.status}`)).catch((e) => logger.warn(`PushMe 推送失败: ${e.message}`))
    );
  }
  if (notice.bark) {
    const key = notice.bark.replace(/^https?:\/\/(api\.day\.app)\//, "").split("/")[0];
    jobs.push(
      fetch(`https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(text)}`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      }).then((r) => logger.ok(`Bark 推送: HTTP ${r.status}`)).catch((e) => logger.warn(`Bark 推送失败: ${e.message}`))
    );
  }

  if (jobs.length === 0) return;
  await Promise.allSettled(jobs);
}

/**
 * 发送每日运行汇总
 * @param {object} ctx 账户上下文
 * @param {string} summary 多行文本
 */
async function sendSummary(ctx, summary) {
  const date = ctx.state.getDateHyphen();
  await sendText(ctx, `Rewards 运行汇总 ${date}`, summary);
}

module.exports = { sendText, sendSummary };
