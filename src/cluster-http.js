/**
 * 汇总机的内置上报接收服务（仅 Electron 版需要）。
 *
 * 【为什么要单独开一个 HTTP 服务】
 *   Docker 版本来就有 server.js 在监听端口，上报端点直接挂在它上面即可。
 *   但 Electron 版**没有任何 HTTP 服务**（界面走 IPC，不走网络），
 *   汇总机要收别的机器上报就必须自己开一个。
 *
 * 【安全边界 —— 这块是往网络上开口子，必须小心】
 *   ① 默认只监听 0.0.0.0？**不** —— 默认监听 0.0.0.0 会让内网任何机器
 *      都能探测到端口。但用户用 ZeroTier/Tailscale 时又必须能从虚拟网卡进来，
 *      而虚拟网卡也是"非环回"。所以只能监听 0.0.0.0，靠**密钥**守门。
 *   ② 没配密钥 → **全部拒收**（见 cluster-service.handleReport）。
 *      宁可让用户多填一个字段，也不能默认裸奔 —— 这台机器可能挂在公网/隧道上。
 *   ③ 只接受 POST /api/cluster/report 这一个路径，其他一律 404。
 *      不做静态托管、不做目录浏览，把攻击面压到最小。
 *   ④ 请求体大小上限（1MB）：上报数据是几十个账号的进度，正常几 KB。
 *      不给上限的话，一个恶意的超大 body 就能吃光内存。
 *   ⑤ 全程不回显内部信息：错误响应只说「密钥不匹配」，不透露配置细节。
 */

const http = require("http");
const logger = require("./logger");
const clusterService = require("./cluster-service");

const MAX_BODY = 1024 * 1024; // 1MB
const REPORT_PATH = "/api/cluster/report";

let server = null;

/** 读请求体（带上限，超限直接断开而不是继续缓存） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 启动接收服务。
 *
 * @param {number} port
 * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
 */
function start(port) {
  return new Promise((resolve) => {
    if (server) return resolve({ ok: true, port: server.address().port });
    const p = Number(port) || 3210;

    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (req.method !== "POST" || url.pathname !== REPORT_PATH) {
          sendJson(res, 404, { ok: false, error: "not found" });
          return;
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${e.message}` });
          return;
        }
        // 密钥从请求头取（不放 URL —— URL 会进日志和代理记录）
        const token = req.headers["x-cluster-token"] || "";
        const r = clusterService.handleReport(body, token);
        sendJson(res, r.status || (r.ok ? 200 : 400), r.ok ? { ok: true } : { ok: false, error: r.error });
        if (r.ok) {
          logger.log("上报", `收到客户端上报：${body.clientId}（${(body.payload && body.payload.accounts && body.payload.accounts.length) || 0} 个账号）`);
        } else {
          logger.warn(`[上报] 拒绝一条上报：${r.error}`);
        }
      } catch (e) {
        // 兜底：任何未预料的异常都不能让服务崩掉，否则汇总链路整个断
        try { sendJson(res, 500, { ok: false, error: "internal error" }); } catch { /* 连接可能已断 */ }
        logger.warn(`[上报] 处理请求异常：${e.message}`);
      }
    });

    // 监听失败（端口被占）要明确报出来，不要静默 —— 否则用户以为在收，
    // 实际客户端全在往一个没人听的端口推。
    server.on("error", (e) => {
      logger.warn(`[上报] 监听 ${p} 端口失败：${e.message}`);
      try { server.close(); } catch { /* 可能没起来 */ }
      server = null;
      resolve({ ok: false, error: e.message });
    });

    server.listen(p, "0.0.0.0", () => {
      logger.info(`[上报] 汇总机监听 0.0.0.0:${p}${REPORT_PATH}（需共享密钥通过校验）`);
      resolve({ ok: true, port: p });
    });
  });
}

/** 停掉接收服务（切换角色/退出程序时调） */
function stop() {
  if (!server) return;
  try { server.close(); } catch { /* 关不干净也要往下走 */ }
  server = null;
  logger.info("[上报] 接收服务已停止");
}

function isRunning() {
  return !!server;
}

function port() {
  try {
    return server ? server.address().port : 0;
  } catch {
    return 0;
  }
}

module.exports = { start, stop, isRunning, port, REPORT_PATH, MAX_BODY };
