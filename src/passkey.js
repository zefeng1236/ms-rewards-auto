"use strict";
/**
 * Passkey（WebAuthn）服务端：注册 + 登录校验，零外部依赖（纯 node:crypto）。
 *
 * 为什么自己做而不用库：容器镜像要小、npm 源要稳，WebAuthn 的服务端校验核心
 * 只有「clientDataJSON 三字段 + authenticatorData 的 rpIdHash/flags + 签名」
 * 三件事，几百行内可完整实现并测透。
 *
 * 信任模型（与本项目保险库一致）：
 *   - 注册必须已有登录会话（防止陌生浏览器给自己发通行证）；
 *   - attestation 取 "none"：不校验厂商证书链，公钥由客户端
 *     `response.getPublicKey()`（SPKI DER，现代浏览器均支持）直接上报；
 *   - 登录（assertion）做完整密码学校验：challenge 一次性、origin 匹配、
 *     rpIdHash = sha256(rpId)、flags 的 UP/UV 位、ECDSA P-256 / RSASSA-PKCS1-v1_5
 *     签名 over (authenticatorData || sha256(clientDataJSON))。
 *   - 凭据存 storage/vault-passkey.json（600），与 vault.json 同目录同信任级。
 *
 * 签名格式：WebAuthn 的 ECDSA 签名是 IEEE P1363（r||s 各 32 字节），
 * 而 node crypto 的 EC 验签要 DER —— p1363ToDer 做转换。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_FILE = () =>
  path.join(process.env.MS_REWARDS_STORAGE_DIR || path.join(__dirname, "..", "storage"), "vault-passkey.json");

const RP_NAME = "MS Rewards Auto";

/* ---------------- base64url ---------------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/* ---------------- 凭据存储 ---------------- */
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE(), "utf8"));
  } catch {
    return { credentials: [] };
  }
}
function saveStore(store) {
  const f = STORE_FILE();
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  try { fs.chmodSync(f, 0o600); } catch {}
}
function hasCredentials() {
  return loadStore().credentials.length > 0;
}
function listForOptions() {
  return loadStore().credentials.map((c) => ({ type: "public-key", id: c.id }));
}

/* ---------------- 一次性 challenge ---------------- */
/** token → { challenge, kind, ts }；kind: create | get */
const pending = new Map();
const PENDING_TTL = 5 * 60 * 1000;
function putChallenge(kind) {
  for (const [k, v] of pending) if (Date.now() - v.ts > PENDING_TTL) pending.delete(k);
  const challenge = b64u(crypto.randomBytes(32));
  pending.set(challenge, { kind, ts: Date.now() });
  return challenge;
}
function takeChallenge(challenge, kind) {
  const v = pending.get(challenge);
  if (!v || v.kind !== kind) return false;
  if (Date.now() - v.ts > PENDING_TTL) { pending.delete(challenge); return false; }
  pending.delete(challenge);
  return true;
}

/* ---------------- 工具 ---------------- */
function rpIdOf(req) {
  const host = String(req.headers.host || "localhost").split(":")[0];
  return host;
}
function originOf(req) {
  // 反向代理场景以 X-Forwarded-Proto 为准；否则按连接是否 TLS 判断不易得，
  // 这里信任 Host + 部署约定的 scheme 环境变量（Docker 自签 https）。
  const proto = req.headers["x-forwarded-proto"] || (process.env.MS_REWARDS_TLS_CERT ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}
function parseClientData(b64) {
  try {
    return JSON.parse(fromB64u(b64).toString("utf8"));
  } catch {
    return null;
  }
}

/** IEEE P1363 (r||s) → DER SEQUENCE{INTEGER r, INTEGER s} */
function p1363ToDer(sig) {
  const half = sig.length / 2;
  const toInt = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let buf = b.slice(i);
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return buf;
  };
  const r = toInt(sig.slice(0, half));
  const s = toInt(sig.slice(half));
  const len = r.length + s.length + 4;
  return Buffer.concat([
    Buffer.from([0x30, len, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ]);
}

function spkiToPem(spkiB64, alg) {
  const der = fromB64u(spkiB64);
  const label = alg === -7 ? "PUBLIC KEY" : "PUBLIC KEY";
  const body = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/* ---------------- 注册 ---------------- */
function registerOptions(req) {
  const store = loadStore();
  return {
    ok: true,
    data: {
      challenge: putChallenge("create"),
      rp: { id: rpIdOf(req), name: RP_NAME },
      user: {
        id: b64u(crypto.randomBytes(16)),
        name: "vault@" + rpIdOf(req),
        displayName: RP_NAME,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      attestation: "none",
      // residentKey 必须 required：preferred 允许浏览器降级成「非可发现凭据」——
      // 那会导致注册成功、能登录，但通行密钥不会出现在浏览器/系统密码管理器里，
      // 观感就是「没保存到浏览器」。required 强制存成可发现的 passkey。
      // ⚠️ 可发现凭据要求 rpId 是域名或 localhost，裸 IP 会被浏览器拒绝。
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 60000,
      excludeCredentials: store.credentials.map((c) => ({ type: "public-key", id: c.id })),
    },
  };
}

function register(req, body) {
  const cd = parseClientData(body && body.clientDataJSON);
  if (!cd || cd.type !== "webauthn.create") return { ok: false, error: "clientDataJSON 类型不符" };
  if (!takeChallenge(cd.challenge, "create")) return { ok: false, error: "challenge 无效或已过期" };
  if (cd.origin !== originOf(req)) return { ok: false, error: `origin 不匹配（${cd.origin}）` };
  const spki = body && body.publicKeySpki;
  const alg = body && body.alg;
  if (!spki || (alg !== -7 && alg !== -257)) return { ok: false, error: "缺少公钥或算法不受支持" };
  const id = String(body.id || "");
  if (!id) return { ok: false, error: "缺少凭据 id" };

  const store = loadStore();
  if (store.credentials.some((c) => c.id === id)) return { ok: false, error: "该通行密钥已注册" };
  store.credentials.push({
    id,
    alg,
    publicKeySpki: spki,
    signCount: 0,
    createdAt: new Date().toISOString(),
    label: (body.label || "通行密钥").slice(0, 40),
  });
  saveStore(store);
  return { ok: true, data: { count: store.credentials.length } };
}

/* ---------------- 登录（assertion） ---------------- */
function authOptions(req) {
  if (!hasCredentials()) return { ok: false, error: "尚未注册通行密钥" };
  return {
    ok: true,
    data: {
      challenge: putChallenge("get"),
      rpId: rpIdOf(req),
      allowCredentials: listForOptions(),
      userVerification: "required",
      timeout: 60000,
    },
  };
}

function auth(req, body) {
  const cd = parseClientData(body && body.clientDataJSON);
  if (!cd || cd.type !== "webauthn.get") return { ok: false, error: "clientDataJSON 类型不符" };
  if (!takeChallenge(cd.challenge, "get")) return { ok: false, error: "challenge 无效或已过期" };
  if (cd.origin !== originOf(req)) return { ok: false, error: `origin 不匹配（${cd.origin}）` };

  const authData = fromB64u(body.authenticatorData || "");
  if (authData.length < 37) return { ok: false, error: "authenticatorData 过短" };
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const expectHash = crypto.createHash("sha256").update(rpIdOf(req)).digest();
  if (!rpIdHash.equals(expectHash)) return { ok: false, error: "rpIdHash 不匹配" };
  if (!(flags & 0x01)) return { ok: false, error: "用户在场位（UP）未置位" };
  if (!(flags & 0x04)) return { ok: false, error: "用户验证位（UV）未置位" };

  const store = loadStore();
  const cred = store.credentials.find((c) => c.id === String(body.id || ""));
  if (!cred) return { ok: false, error: "未注册的通行密钥" };

  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(fromB64u(body.clientDataJSON)).digest()]);
  const sig = fromB64u(body.signature || "");
  const pem = spkiToPem(cred.publicKeySpki, cred.alg);
  const tryVerify = (alg) => {
    try {
      if (alg === -7) {
        return crypto.verify("sha256", signed, { key: pem, dsaEncoding: "der" }, p1363ToDer(sig));
      }
      return crypto.verify("sha256", signed, pem, sig);
    } catch {
      return false;
    }
  };
  // 主算法失败时回退另一种（防注册时 alg 上报错误；真实浏览器都会正确上报，
  // 虚拟认证器/老凭据是主要风险源）
  let verified = tryVerify(cred.alg);
  if (!verified) verified = tryVerify(cred.alg === -7 ? -257 : -7);
  if (!verified) return { ok: false, error: "签名校验失败" };

  cred.signCount = authData.readUInt32BE(33) || cred.signCount + 1;
  saveStore(store);
  return { ok: true };
}

/** 删除某条凭据（设置页管理用） */
function removeCredential(id) {
  const store = loadStore();
  const before = store.credentials.length;
  store.credentials = store.credentials.filter((c) => c.id !== id);
  if (store.credentials.length === before) return { ok: false, error: "凭据不存在" };
  saveStore(store);
  return { ok: true, data: { count: store.credentials.length } };
}

function status() {
  const store = loadStore();
  return {
    enabled: store.credentials.length > 0,
    count: store.credentials.length,
    labels: store.credentials.map((c) => c.label),
    ids: store.credentials.map((c) => c.id),
  };
}

module.exports = { registerOptions, register, authOptions, auth, removeCredential, status, hasCredentials };
