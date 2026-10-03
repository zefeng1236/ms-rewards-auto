/**
 * GitHub 优选 IP（hosts 加速）
 *
 * 为什么需要它 —— 实测抓到的三件事：
 *   1. 很多国内网络环境（含本机）会在 **系统 hosts 里把 github.com 指向 127.0.0.1**
 *      直接阻断，直连必然失败；gh-proxy 镜像虽有 CDN 兜底，但单连接被限速到
 *      0.5MiB/s 量级。
 *   2. hosts.gitcdn.top 提供的 hosts.json 是**按国内线路优选过的真实 IP**，
 *      绕过本地 hosts 阻断 + 绕开镜像限速。
 *   3. Release 下载会302 跳到 release-assets.githubusercontent.com，
 *      这个域名**不在** hosts.json 里（实测），所以只需要给 github.com
 *      指定 IP 就能打通整条链，第二跳走正常 DNS 即可。
 *
 * 实现方式：**不写系统 hosts**（要管理员权限、会污染用户全局环境），
 * 而是在 https.request 的 lookup 回调里返回指定 IP —— SNI 与证书校验
 * 仍按域名走，所以 GitHub 的证书验证照常通过，不会因为换 IP 而失去安全性。
 *
 * 缓存：优选 IP 半天内复用（实测解析出来的 IP 短期不会变，避免每次下载都
 * 额外打一个接口）。hosts.json 本身 gzip 后只有 1.7KB，取一次成本极低。
 */

const https = require("https");

/** 优选 IP 数据源：返回形如 { "10": ["20.205.243.166","github.com"], ... } */
const HOSTS_JSON_URL = "https://hosts.gitcdn.top/hosts.json";

/** 缓存有效期：6 小时 */
const TTL_MS = 6 * 60 * 60 * 1000;

/** 我们关心的域名（本项目下载链只用到这两个） */
const WANTED = ["github.com", "api.github.com"];

let cache = { at: 0, map: {} };

/**
 * 拉取并解析 hosts.json → { 域名: 优选 IP }。
 *
 * 解析容错：接口返回的是扁平对象，key 是数组下标的字符串，value 是
 * `[ip, domain]`。任何一条不符合结构就跳过那条，不能因为一个域名
 * 的格式变了就让整份缓存作废。
 *
 * @returns {Promise<Record<string,string>>} 域名 → IP；取不到时返回 {} （空对象，
 *   调用方看到空就该退回普通直连，不该抛错卡住下载）
 */
async function fetchPreferredIps() {
  if (Date.now() - cache.at < TTL_MS && Object.keys(cache.map).length) return cache.map;

  return new Promise((resolve) => {
    const req = https.get(
      HOSTS_JSON_URL,
      { timeout: 8000, headers: { Accept: "application/json", "User-Agent": "MS-Rewards-Auto" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({});
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        // 上限 512KB：这是1.7KB 的接口，异常大响应直接掐掉防挂住
        res.on("data", (d) => {
          raw += d;
          if (raw.length > 512 * 1024) {
            req.destroy();
            resolve({});
          }
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(raw);
            const map = {};
            for (const v of Object.values(j || {})) {
              if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "string" && typeof v[1] === "string") {
                map[v[1]] = v[0];
              }
            }
            cache = { at: Date.now(), map };
            resolve(map);
          } catch {
            resolve({});
          }
        });
        res.on("error", () => resolve({}));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({});
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * 取指定域名的优选 IP（没有则返回 null，调用方走普通直连）。
 *
 * ⚠️ 必须**按域名分别取**：实测 hosts.json 里 github.com = 20.205.243.166 而
 * api.github.com = 20.205.243.168（同一网段的不同机器）。拿 github.com 的 IP
 * 去打 api.github.com 会拿到 **403**（GitHub 按 SNI/前端匹配，串了就是错的机器），
 * 表现为"api 探测静默失败 → sha256 拿不到 → 完整性校验被跳过"。
 *
 * @param {string} [domain="github.com"]
 * @returns {Promise<string|null>}
 */
async function ipFor(domain) {
  const d = String(domain || "github.com").toLowerCase();
  const map = await fetchPreferredIps();
  return map[d] || null;
}

/** github.com 的优选 IP（下载路径用） */
async function githubIp() {
  return ipFor("github.com");
}

/** api.github.com 的优选 IP（探测 / sha256 校验用） */
async function apiGithubIp() {
  return ipFor("api.github.com");
}

/**
 * 供 https.request 使用的 lookup：把指定域名解析固定到它自己的优选 IP。
 *
 * 只接管白名单里的域名，其余照常走系统 DNS —— 302 跳到的
 * release-assets.githubusercontent.com 不在名单里（实测 hosts.json 没有它），
 * 交给系统解析才能打通第二跳。
 *
 * @param {Record<string,string>} ipMap 域名 → IP（可只含其中一个）
 * @returns {(hostname: string, options: object, cb: Function) => void}
 */
function pinnedLookup(ipMap) {
  const map = typeof ipMap === "string" ? { "github.com": ipMap, "api.github.com": ipMap } : ipMap || {};
  return (hostname, options, cb) => {
    const h = String(hostname).toLowerCase();
    const ip = map[h];
    if (!ip || !WANTED.includes(h)) {
      // 非白名单域名 / 没查到IP：用系统解析。dns.lookup 的 options 形态要原样转发。
      try {
        require("dns").lookup(hostname, options, cb);
      } catch {
        cb(new Error(`无法解析 ${hostname}`));
      }
      return;
    }
    if (options && options.all) cb(null, [{ address: ip, family: 4 }]);
    else cb(null, ip, 4);
  };
}

module.exports = {
  HOSTS_JSON_URL,
  TTL_MS,
  WANTED,
  fetchPreferredIps,
  githubIp,
  apiGithubIp,
  ipFor,
  pinnedLookup,
};