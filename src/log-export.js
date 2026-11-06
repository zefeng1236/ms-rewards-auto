/**
 * 「报告问题」日志导出（2026-11-06）
 *
 * 为什么自己写 ZIP：项目里没有压缩库（archiver/adm-zip/yazl/jszip 都没装），
 * 为一键导出日志引入新依赖不划算。ZIP 的 store/deflate 格式很直白，
 * 用 Node 内置 zlib + 手写三个结构（local header / central directory / EOCD）即可，
 * 产出能被 Windows 资源管理器、7-Zip、unzip 正常打开。
 *
 * 数据来源：
 *   - logs/app.log                          全局日志，每行 `[YYYY-MM-DD HH:MM:SS] ...`
 *   - logs/accounts/<id>/YYYY-MM-DD.jsonl  按账号按天切分的历史日志（每行有 time 字段）
 *
 * ⚠️ 脱敏是**默认关闭**的（用户指定）：调用方必须显式传 redact:true 才生效。
 *    默认导出原始日志是用户自己的选择，但完成弹窗会明确提示隐私风险。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

/* ------------------------------ CRC32 ------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 最小 ZIP 打包：deflateRaw 压缩，条目名一律 UTF-8（flag bit 11） */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // DOS 时间/日期：ZIP 沿用 1980 起算的位域，用当前时间即可
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const packed = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags: UTF-8 文件名
    lh.writeUInt16LE(8, 8);         // method: deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);        // extra len
    locals.push(lh, nameBuf, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);    // flags
    ch.writeUInt16LE(8, 10);        // method
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra len
    ch.writeUInt16LE(0, 32);        // comment len
    ch.writeUInt16LE(0, 34);        // disk start
    ch.writeUInt16LE(0, 36);        // internal attrs
    ch.writeUInt32LE(0, 38);        // external attrs
    ch.writeUInt32LE(offset, 42);   // local header offset
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + packed.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ------------------------------ 脱敏 ------------------------------ */
/**
 * 隐藏账号 ID 与推送地址里的密钥。
 *
 * 覆盖：UUID 账号 ID、钉钉 access_token / 加签 SEC、企业微信 key、
 * 飞书 hook 尾段、Bark / PushMe 的设备串、以及通用的 token/key/secret 查询参数。
 * ⚠️ 只替换「值」，保留域名与参数名 —— 排查时要能看出是哪个通道出的问题。
 */
function redactText(text) {
  let s = String(text == null ? "" : text);
  // 1) UUID 形式的账号 ID（日志正文、目录名、JSON 字段里都可能出现）
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[账号ID已隐藏]");
  // 2) URL 查询参数里的密钥（access_token / key / token / secret / password / code）
  s = s.replace(/([?&](?:access_token|key|token|secret|password|pwd|code)=)[^&\s"'|]+/gi, "$1[已隐藏]");
  s = s.replace(/(access_token=)[0-9a-f*]{4,}/gi, "$1[已隐藏]");
  // 3) 钉钉加签密钥（SEC + 64 hex）
  s = s.replace(/\bSEC[0-9a-f]{32,}\b/gi, "[加签密钥已隐藏]");
  // 4) 飞书 webhook 尾段 /open-apis/bot/v2/hook/<token>
  s = s.replace(/(\/open-apis\/bot\/v2\/hook\/)[A-Za-z0-9_-]{8,}/gi, "$1[已隐藏]");
  // 5) Bark https://api.day.app/<deviceKey>/...
  s = s.replace(/(api\.day\.app\/)[A-Za-z0-9_-]{6,}/gi, "$1[已隐藏]");
  // 6) Server酱 / PushMe 之类把密钥放在路径里的：/send/<key>.send
  s = s.replace(/(\/send\/)[A-Za-z0-9_-]{8,}/gi, "$1[已隐藏]");
  // 7) 已经半脱敏过的形态（logger 自己打的 6252****be93）也补一刀
  s = s.replace(/\b([0-9a-f]{4})\*{2,}([0-9a-f]{4})\b/gi, "$1[已隐藏]$2");
  return s;
}

/* ------------------------------ 时间范围 ------------------------------ */
const RANGE_PRESETS = ["today", "24h", "48h", "72h", "week", "month", "all", "custom"];

/** 把预设/自定义换算成 [from, to] 毫秒。所有边界都按**本地时区**算。 */
function resolveRange(opts, nowMs = Date.now()) {
  const preset = String((opts && opts.preset) || "today");
  const now = new Date(nowMs);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  switch (preset) {
    case "today": return [startOfDay, nowMs];
    case "24h": return [nowMs - 24 * 3600e3, nowMs];
    case "48h": return [nowMs - 48 * 3600e3, nowMs];
    case "72h": return [nowMs - 72 * 3600e3, nowMs];
    case "week": {
      // 中国习惯周一为一周起点
      const dow = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow, 0, 0, 0, 0);
      return [monday.getTime(), nowMs];
    }
    case "month": return [new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime(), nowMs];
    case "all": return [0, nowMs];
    case "custom": {
      const a = String((opts && opts.from) || "").slice(0, 10);
      const b = String((opts && opts.to) || a).slice(0, 10);
      const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
      if (!pa) return [startOfDay, nowMs];
      const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b) || pa;
      const da = new Date(+pa[1], +pa[2] - 1, +pa[3], 0, 0, 0, 0);
      const db = new Date(+pb[1], +pb[2] - 1, +pb[3], 23, 59, 59, 999);
      return [Math.min(da.getTime(), db.getTime()), Math.max(endOfDay(db), db.getTime())];
    }
    default: return [startOfDay, nowMs];
  }
}

/** app.log 行首时间戳 → 毫秒；解析不了返回 null（由调用方决定是否保留） */
function parseLogTime(line) {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/.exec(line);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/* ------------------------------ 收集 ------------------------------ */
/** 列出 logs/accounts 下所有存在日志的日期（YYYY-MM-DD，新→旧），供自定义日期置灰 */
function availableDays(logDir) {
  const root = path.join(logDir, "accounts");
  const out = new Set();
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(root, d.name))) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m) out.add(m[1]);
      }
    }
  } catch {}
  // app.log 里出现的日期也算「有日志」
  try {
    const text = fs.readFileSync(path.join(logDir, "app.log"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\[(\d{4}-\d{2}-\d{2}) /.exec(line);
      if (m) out.add(m[1]);
    }
  } catch {}
  return [...out].sort((a, b) => b.localeCompare(a));
}

/**
 * 收集日志内容 → ZIP Buffer。
 * @returns {{buffer:Buffer, sha256:string, bytes:number, files:string[], lines:number}}
 */
function buildLogZip({ logDir, version, opts = {}, nowMs = Date.now() }) {
  const [from, to] = resolveRange(opts, nowMs);
  const redact = opts.redact === true;
  const entries = [];
  const fileList = [];
  let lineCount = 0;
  const push = (name, text) => {
    const content = redact ? redactText(text) : String(text);
    // 目录/文件名里也可能带账号 ID
    const safeName = redact ? redactText(name).replace(/\[账号ID已隐藏\]/g, "account") : name;
    entries.push({ name: safeName, content });
    fileList.push(safeName);
  };

  // 1) 全局 app.log：逐行按时间戳过滤
  try {
    const raw = fs.readFileSync(path.join(logDir, "app.log"), "utf8");
    const kept = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const t = parseLogTime(line);
      if (t == null || (t >= from && t <= to)) {
        kept.push(line);
        lineCount++;
      }
    }
    push("app.log", kept.join("\n") + (kept.length ? "\n" : ""));
  } catch {
    push("app.log", "（未找到 app.log）\n");
  }

  // 2) 各账号按天 jsonl：文件名先按日期粗筛，行内 time 再精筛
  const accountsRoot = path.join(logDir, "accounts");
  try {
    for (const d of fs.readdirSync(accountsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(accountsRoot, d.name);
      for (const f of fs.readdirSync(dir).sort()) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        const dayTs = new Date(+m[1].slice(0, 4), +m[1].slice(5, 7) - 1, +m[1].slice(8, 10)).getTime();
        const dayEnd = dayTs + 24 * 3600e3 - 1;
        if (dayEnd < from || dayTs > to) continue;
        let raw = "";
        try { raw = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
        const kept = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let t = dayTs;
          try {
            const j = JSON.parse(line);
            const mm = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(j.time || ""));
            if (mm) t = new Date(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]).getTime();
          } catch { /* 非 JSON 行按整天保留 */ }
          if (t >= from && t <= to) { kept.push(line.trim()); lineCount++; }
        }
        if (kept.length) push(`accounts/${d.name}/${f}`, kept.join("\n") + "\n");
      }
    }
  } catch {}

  // 3) 清单：说明范围、脱敏状态、版本，便于收件人判断日志是否完整
  const fmt = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false });
  const manifest = {
    product: "MS Rewards Auto",
    version: String(version || ""),
    exportedAt: new Date(nowMs).toISOString(),
    range: { preset: String(opts.preset || "today"), from: fmt(from), to: fmt(to) },
    redacted: redact,
    notice: redact
      ? "已启用脱敏：账号 ID 与推送地址密钥已隐藏"
      : "未启用脱敏：日志可能包含账号 ID、推送地址密钥等敏感信息，请妥善保管",
    files: fileList,
    totalLines: lineCount,
  };
  push("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = makeZip(entries);
  return {
    buffer,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
    files: fileList,
    lines: lineCount,
  };
}

/** 生成带时间 + 哈希的导出文件名：ms-rewards-logs-20261106-192208-a1b2c3d4.zip */
function exportFileName(sha256, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `ms-rewards-logs-${stamp}-${String(sha256 || "").slice(0, 8)}.zip`;
}

module.exports = {
  RANGE_PRESETS,
  makeZip,
  redactText,
  resolveRange,
  parseLogTime,
  availableDays,
  buildLogZip,
  exportFileName,
};
