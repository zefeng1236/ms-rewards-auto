/**
 * Passkey（WebAuthn）浏览器端客户端。
 *
 * 只在安全上下文（HTTPS / localhost）下可用；纯 HTTP 下 navigator.credentials
 * 为 undefined，调用会直接抛错——界面上据此置灰按钮并提示。
 *
 * 注册：create() 时把公钥以 SPKI DER（response.getPublicKey()）一并上报，
 * 服务端存 SPKI 即可做后续 assertion 验签（attestation 取 none，不验厂商链）。
 * 登录：get() 后把 signature / authenticatorData / clientDataJSON 原样上报。
 */

const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export function passkeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials &&
    window.isSecureContext
  );
}

type Rest = { ok: boolean; error?: string; data?: any };

async function post(url: string, body: unknown): Promise<Rest> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body || {}),
  });
  return (await res.json()) as Rest;
}

export async function passkeyStatus(): Promise<{ enabled: boolean; count: number; labels: string[]; ids: string[] }> {
  const res = await fetch("/api/passkey/status", { credentials: "same-origin" });
  const j = (await res.json()) as Rest;
  return j.data || { enabled: false, count: 0, labels: [], ids: [] };
}

/** 注册一枚通行密钥（需已登录会话） */
export async function registerPasskey(label: string): Promise<Rest> {
  const opt = await post("/api/passkey/register-options", {});
  if (!opt.ok) return opt;
  const d = opt.data;
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(d.challenge),
      rp: d.rp,
      user: {
        id: fromB64u(d.user.id),
        name: d.user.name,
        displayName: d.user.displayName,
      },
      pubKeyCredParams: d.pubKeyCredParams,
      attestation: "none",
      authenticatorSelection: d.authenticatorSelection,
      timeout: d.timeout,
      excludeCredentials: (d.excludeCredentials || []).map((c: any) => ({
        type: c.type,
        id: fromB64u(c.id),
      })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) return { ok: false, error: "浏览器未返回凭据（用户取消？）" };
  const resp = cred.response as AuthenticatorAttestationResponse;
  const spki = typeof (resp as any).getPublicKey === "function" ? (resp as any).getPublicKey() : null;
  if (!spki) return { ok: false, error: "浏览器不支持上报公钥（getPublicKey），无法注册" };
  // alg 必须取真实值：PublicKeyCredential 对象本身没有 alg 属性，
  // 但 AuthenticatorAttestationResponse.getPublicKeyAlgorithm() 有（COSE 标识）。
  // 猜错算法会导致服务端验签走错分支（虚拟认证器默认 RS256 即踩过）。
  const alg =
    typeof (resp as any).getPublicKeyAlgorithm === "function" ? (resp as any).getPublicKeyAlgorithm() : -7;
  return post("/api/passkey/register", {
    id: cred.id,
    alg,
    publicKeySpki: b64u(spki),
    clientDataJSON: b64u(resp.clientDataJSON),
    label,
  });
}

/** 用通行密钥登录（无需会话） */
export async function loginWithPasskey(): Promise<Rest> {
  const opt = await post("/api/passkey/auth-options", {});
  if (!opt.ok) return opt;
  const d = opt.data;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(d.challenge),
      rpId: d.rpId,
      allowCredentials: (d.allowCredentials || []).map((c: any) => ({
        type: c.type,
        id: fromB64u(c.id),
      })),
      userVerification: d.userVerification,
      timeout: d.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return { ok: false, error: "浏览器未返回凭据（用户取消？）" };
  const resp = cred.response as AuthenticatorAssertionResponse;
  return post("/api/passkey/auth", {
    id: cred.id,
    clientDataJSON: b64u(resp.clientDataJSON),
    authenticatorData: b64u(resp.authenticatorData),
    signature: b64u(resp.signature),
  });
}

export async function removePasskey(id: string): Promise<Rest> {
  return post("/api/passkey/remove", { id });
}
