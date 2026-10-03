/**
 * 底层 HTTP 客户端：支持「指定 IP 直连」与「手动跟随重定向」。
 *
 * 为什么不用现成的 fetch：两个硬需求 fetch 满足不了
 *   1. **把域名解析固定到指定 IP**（SNI 与证书仍按域名校验，安全性不丢）。
 *      这是绕开「本地 hosts 把 github.com 指向 127.0.0.1」这类阻断的唯一干净做法
 *      —— 不改系统 hosts、不降级 TLS 校验。
 *   2. **手动跟随重定向**。Release 下载会 302 跳到
 *      release-assets.githubusercontent.com，这个域名**没有**优选 IP，
 *      必须让第二跳走系统 DNS；而 https.request 不会自动跟跳转，得自己实现。
 *
 * 返回值刻意做成「类fetch 响应」：{ status, headers.get(name), body }，
 * 其中 body 是 Web ReadableStream —— 这样上层分片下载器既能吃本模块的响应，
 * 也能吃原生 fetch 的响应，两条路径共用同一套写盘/进度逻辑。
 */

const https = require("https");
const http = require("http");
const { Readable } = require("stream");
const { pinnedLookup } = require("./fast-hosts");

/** 最多跟几跳重定向（GitHub 实际 1 跳；留余量防循环） */
const MAX_REDIRECTS = 5;

/** Node 的 headers 对象 → 大小写不敏感的 get() 访问器 */
function headerBag(raw) {
  const lower = {};
  for (const k of Object.keys(raw || {})) lower[k.toLowerCase()] = raw[k];
  return {
    get: (name) => {
      const v = lower[String(name).toLowerCase()];
      return Array.isArray(v) ? v.join(", ") : v === undefined ? null : v;
    },
    raw: lower,
  };
}

/**
 * 发一个请求（不跟随重定向），把 Node 响应包装成**与 fetch 同形**的对象。
 *
 * 同形很重要：上层（probeTotal 等）要同时吃 fetch 与本模块的响应，
 * 判据是 `res.ok` / `res.json()`。只包headers 和 body 的话，`res.ok` 是
 * undefined → 上层直接当失败跳过 → sha256 静默为 null（实测踩过）。
 *
 * @param {string} url
 * @param {object} opts
 * @param {string} [opts.method="GET"]
 * @param {object} [opts.headers]
 * @param {AbortSignal} [opts.signal] 外部取消
 * @param {number} [opts.timeoutMs] 首字节超时（拿到响应头即撤表）
 * @param {string|Record<string,string>} [opts.ip] 把该 URL 的主机名解析固定到这个 IP
 *   （或「域名 → IP」映射表）；SNI 仍用域名，证书校验照常。
 *   ⚠️ 必须是**映射表**而不是单个 IP：实测 github.com=20.205.243.166 与
 *   api.github.com=20.205.243.168 是两台机器。
 * @returns {Promise<{ok:boolean, status:number, headers:{get:Function},
 *   json:Function, text:Function, body:ReadableStream, url:string}>}
 */
function requestOnce(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`非法 URL: ${url}`));
      return;
    }
    const mod = u.protocol === "http:" ? http : https;
    const reqOpts = {
      method: o.method || "GET",
      headers: {
        // ⚠️ User-Agent 必须有：GitHub REST API 对缺 UA 的请求直接回
        // **403 "Request forbidden by administrative rules"**（实测踩到，
        // 排查时容易误以为是 IP 被拒 —— 其实是这个头）。
        // 对下载大文件无所谓，但对 api.github.com 是硬性要求。
        "User-Agent": "MS-Rewards-Auto",
        ...(o.headers || {}),
      },
      // 首字节超时自己管：req.setTimeout 在拿到响应头后就不再适合，
      // 因为大文件的body 传输可能长时间静默（那是空闲超时的职责）
    };
    if (o.timeoutMs) {
      reqOpts.timeout = o.timeoutMs;
    }
    if (o.ip) {
      reqOpts.lookup = pinnedLookup(o.ip);
      //显式 SNI：换了IP 但证书仍按域名校验，否则 GitHub 的证书会验不过
      reqOpts.servername = u.hostname;
      reqOpts.host = u.hostname;
    }

    const req = mod.request(url, reqOpts, (res) => {
      const body = Readable.toWeb(res);
      // 与 fetch 同形：ok / json / text 全都要有，上层才能不分支地处理两种响应
      const wrapped = {
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: headerBag(res.headers),
        body,
        url,
        json: async () => JSON.parse(Buffer.from(await new Response(body).arrayBuffer()).toString("utf8")),
        text: async () => Buffer.from(await new Response(body).arrayBuffer()).toString("utf8"),
      };
      resolve(wrapped);
    });

    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {}
      reject(e);
    };

    if (o.signal) {
      if (o.signal.aborted) {
        const err = new Error("下载已取消");
        err.canceled = true;
        fail(err);
        return;
      }
      req.on("close", () => {
        if (o.signal.aborted) {
          const err = new Error("下载已取消");
          err.canceled = true;
          fail(err);
        }
      });
    }
    req.on("timeout", () => {
      const err = new Error(`连接超时（${Math.round((o.timeoutMs || 0) / 1000)} 秒内没拿到响应头）`);
      err.timeout = true;
      fail(err);
    });
    req.on("error", (e) => {
      const err = new Error(e.message);
      if (o.signal && o.signal.aborted) err.canceled = true;
      fail(err);
    });
    req.end();
  });
}

/**
 * 跟随重定向的GET。
 *
 * 每跳都重新决定要不要用 IP：
 *   - 只有 github.com / api.github.com 在优选名单里（fast-hosts 的白名单）；
 *   - 302 跳到的 release-assets.githubusercontent.com 不在名单 → 自动改走系统 DNS。
 * 实测这条链必须这么走才能通：github.com 被本地 hosts 阻断，但第二跳不阻断。
 *
 * @param {string} url
 * @param {object} opts 同requestOnce，另加 maxRedirects
 */
async function get(url, opts) {
  const o = opts || {};
  const max = o.maxRedirects === undefined ? MAX_REDIRECTS : o.maxRedirects;
  let cur = url;
  let ip = o.ip;
  for (let hop = 0; hop <= max; hop++) {
    const res = await requestOnce(cur, { ...o, url: cur, ip });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      try {
        res.body.cancel();
      } catch {}
      cur = new URL(loc, cur).toString();
      // 换域名后，优选 IP 只对白名单域名有效
      if (!/^https?:\/\/(github\.com|api\.github\.com)\//.test(cur)) ip = undefined;
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}

module.exports = {
  MAX_REDIRECTS,
  headerBag,
  requestOnce,
  get,
};