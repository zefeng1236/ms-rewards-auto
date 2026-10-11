import { useCallback, useEffect, useRef, useState } from "react";
import { GlassButton } from "@ttqtt/liquid-glass-react";
import { AppCard, toast } from "../components/liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { NumberField, SelectField, TextField } from "../components/fields";
import type { AppConfig, ClusterRuntimeState, ClusterIdentity } from "../types";

/**
 * 软件设置 →「跨客户端汇总」分区（2026-10-11）。
 *
 * 【这功能在解决什么】多台/多地客户端把完成情况推到同一个钉钉群，
 * 但群消息是时间流，看一屏只能看到最近几条，「谁没做」一眼看不出来。
 * 这里配置的是：**谁汇总（hub）、谁上报（client）、报告怎么发进群**。
 *
 * 【网络怎么打通】软件本身**不内置** ZeroTier / Tailscale / EasyTier / Cloudflare Tunnel：
 * 那些要么要装内核驱动 + 管理员权限（指纹/杀软会拦），要么要账号登录 + 域名。
 * 软件只认「URL + 共享密钥」两个值，网络层你自己选、自己打通 —— 填上就能用。
 * 所以这里的说明文字会把三种典型地址写清楚，避免用户以为软件自带组网。
 *
 * 【两条路怎么选】
 *   - 多数人：本机当汇总机（hub），别处的机器当客户端（client）填地址上报。
 *   - 只有一台机器：不用开这功能（role=off）。
 *
 * 改配置立即生效：本组件每次保存都调 clusterRestart（先停后起，幂等），
 * 否则改了端口/间隔看起来保存了、实际监听的还是旧值。
 */
export function ClusterPanel() {
  const [cfg, setCfg] = useState<AppConfig["cluster"] | null>(null);
  const [st, setSt] = useState<{
    state?: ClusterRuntimeState;
    http?: { running: boolean; port: number; via?: string };
    identity?: ClusterIdentity;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  /** 本机 clientId 只在用户点按钮时才展开，避免一直占一行 */
  const [showId, setShowId] = useState(false);
  /** 防止连点：按钮在上一次调用回来前保持禁用 */
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.clusterState?.();
      if (r && r.ok) {
        setSt({ state: r.state, http: r.http, identity: r.identity });
        if (r.config) setCfg(r.config);
      }
    } catch {
      /* 预览 / IPC 不可用：保持上次数据 */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getGlobalConfig()
      .then((c) => {
        if (alive && c?.cluster) setCfg(c.cluster);
      })
      .catch(() => {});
    void refresh();
    // 每 20 秒回读一次状态：在线/最后上报时间是会变的，不刷新就成了摆设
    const t = setInterval(() => {
      if (alive) void refresh();
    }, 20000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refresh]);

  /** 保存一段配置；restart=true 时顺带重启编排让改动立即生效 */
  const save = async (patch: Partial<AppConfig["cluster"]>, restart = true) => {
    if (!cfg) return;
    const merged = { ...cfg, ...patch };
    setCfg(merged);
    try {
      const next = await api.setGlobalConfig({ cluster: patch });
      if (next?.cluster) setCfg(next.cluster);
      if (restart) await api.clusterRestart?.();
      await refresh();
    } catch {
      toast.error("保存失败");
    }
  };

  /**
   * 跑一个异步动作并把结果回显在面板上。
   * 用 inflight 锁：这些按钮都会真的发网络请求，连点会造成重复报告/重复上报。
   */
  const run = async (label: string, fn: () => Promise<{ ok?: boolean; error?: string; note?: string } | void>) => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setNote(`${label}…`);
    try {
      const r = (await fn()) || {};
      if (r.ok === false) {
        setNote(`${label}失败：${r.error || "未知错误"}`);
      } else {
        setNote(`${label}成功${r.note ? `：${r.note}` : ""}`);
      }
    } catch (e) {
      setNote(`${label}失败：${(e as Error)?.message || e}`);
    } finally {
      inflight.current = false;
      setBusy(false);
      await refresh();
    }
  };

  if (!cfg) return <div className="hint">加载中…</div>;

  const role = cfg.role || "off";
  const view = st?.state?.view;
  const clients = view?.clients || [];

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">跨客户端汇总</div>
          <div className="block-sub">
            多台机器把账号完成情况推到同一个钉钉群，一眼看出哪个账号没完成
          </div>
        </div>
      </div>

      <AppCard padding={16}>
        {/* 本机角色：决定下面显示哪一组表单 */}
        <SelectField
          label="本机角色"
          hint={
            role === "hub"
              ? "汇总机：接收各客户端上报，定时/手动生成报告发进群"
              : role === "client"
                ? "客户端：按间隔把本机账号状态上报给汇总机"
                : "不参与跨客户端汇总"
          }
          value={role}
          options={[
            { value: "off", label: "关闭（不参与）" },
            { value: "hub", label: "汇总机（收上报 + 发报告）" },
            { value: "client", label: "客户端（只上报）" },
          ]}
          onChange={(v) => void save({ role: v as AppConfig["cluster"]["role"] })}
        />

        {/* —— 客户端要填的 —— */}
        {role === "client" && (
          <>
            <TextField
              label="汇总机上报地址"
              hint="填汇总机的地址（不用带路径，会自动补 /api/cluster/report）。示例：http://100.64.0.5:3210（ZeroTier/Tailscale 虚拟 IP）、http://hub-pc:3210（内网主机名）、https://msr.example.com（Cloudflare Tunnel / 公网域名）"
              value={cfg.reportUrl}
              placeholder="http://100.64.0.5:3210"
              onChange={(v) => setCfg({ ...cfg, reportUrl: v })}
            />
            <TextField
              label="共享密钥"
              hint="两边填同一个值即可（汇总机留空会拒收所有上报）。它只是挡陌生扫描，不是账号密码"
              value={cfg.reportToken}
              placeholder="随便一串，如 msr-2026"
              onChange={(v) => setCfg({ ...cfg, reportToken: v })}
            />
            <NumberField
              label="上报间隔（分钟）"
              hint="太密费流量，太疏统计不及时；默认 5 分钟"
              value={cfg.pushIntervalMin}
              min={1}
              max={1440}
              onChange={(v) => setCfg({ ...cfg, pushIntervalMin: Math.max(1, v || 5) })}
            />
          </>
        )}

        {/* —— 汇总机要填的 —— */}
        {role === "hub" && (
          <>
            {!IS_WEB && (
              <NumberField
                label="监听端口"
                hint="汇总机接收上报的端口（Docker 版走主服务端口，此项不生效）。改完立即重启监听"
                value={cfg.listenPort}
                min={1}
                max={65535}
                onChange={(v) => setCfg({ ...cfg, listenPort: Math.max(1, v || 3210) })}
              />
            )}
            <TextField
              label="共享密钥"
              hint="与客户端填同一个值。留空 = 拒收所有上报（防公网裸奔）"
              value={cfg.reportToken}
              placeholder="随便一串，如 msr-2026"
              onChange={(v) => setCfg({ ...cfg, reportToken: v })}
            />
            <TextField
              label="应做账号清单"
              hint="逗号/换行分隔。填了才知道「谁没做」——留空则报告只显示完成清单，不出未完成段"
              value={cfg.expectedAccounts}
              placeholder="账号A,账号B,账号C"
              onChange={(v) => setCfg({ ...cfg, expectedAccounts: v })}
            />
            <NumberField
              label="自动报告间隔（分钟）"
              hint="0 = 不定时推送，只在下方手动点「立即生成报告」"
              value={cfg.reportIntervalMin}
              min={0}
              max={1440}
              onChange={(v) => setCfg({ ...cfg, reportIntervalMin: Math.max(0, v || 0) })}
            />
            <SelectField
              label="报告发送方式"
              hint={
                cfg.reportVia === "app"
                  ? "用企业内部应用机器人发（下面三项必填）"
                  : "复用「推送通知」里已配好的 webhook（最省事，多数人已配）"
              }
              value={cfg.reportVia}
              options={[
                { value: "notice", label: "复用推送通知的 webhook" },
                { value: "app", label: "企业内部应用机器人" },
              ]}
              onChange={(v) => void save({ reportVia: v as AppConfig["cluster"]["reportVia"] }, false)}
            />
            {cfg.reportVia === "app" && (
              <>
                <TextField
                  label="Client ID"
                  hint="钉钉开发者后台「凭证与基础信息」里的 Client ID，同时作 robotCode"
                  value={cfg.appKey}
                  placeholder="a3970502-…"
                  onChange={(v) => setCfg({ ...cfg, appKey: v })}
                />
                <TextField
                  label="Client Secret"
                  hint="同一页的 Client Secret"
                  value={cfg.appSecret}
                  placeholder="Sv_…"
                  onChange={(v) => setCfg({ ...cfg, appSecret: v })}
                />
                <TextField
                  label="群会话 ID（openConversationId）"
                  hint="是群 ID 不是群名。可用 dingtalk-app.js 的 learnConversation 从一次群消息里学到"
                  value={cfg.openConversationId}
                  placeholder="cidv2XXX…"
                  onChange={(v) => setCfg({ ...cfg, openConversationId: v })}
                />
              </>
            )}
          </>
        )}

        {/* —— 操作按钮：所有角色通用 —— */}
        <div className="field-row" style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
          <GlassButton
            variant="plain"
            controlSize="small"
            disabled={busy}
            onClick={() => void save({})}
          >
            保存并生效
          </GlassButton>
          <GlassButton
            variant="plain"
            controlSize="small"
            disabled={busy}
            onClick={() => void run("测试发送", () => api.clusterTest?.() ?? Promise.resolve())}
          >
            测试发送
          </GlassButton>
          {role === "hub" && (
            <GlassButton
              variant="plain"
              controlSize="small"
              disabled={busy}
              onClick={() => void run("生成报告", () => api.clusterReportNow?.() ?? Promise.resolve())}
            >
              立即生成报告
            </GlassButton>
          )}
          {role === "client" && (
            <GlassButton
              variant="plain"
              controlSize="small"
              disabled={busy}
              onClick={() => void run("上报", () => api.clusterPushNow?.() ?? Promise.resolve())}
            >
              立即上报一次
            </GlassButton>
          )}
          <GlassButton
            variant="plain"
            controlSize="small"
            disabled={busy}
            onClick={() => setShowId((v) => !v)}
          >
            {showId ? "隐藏本机 ID" : "显示本机 clientId"}
          </GlassButton>
        </div>

        {showId && st?.identity && (
          <div className="hint" style={{ marginTop: 8, wordBreak: "break-all" }}>
            本机 clientId：<code>{st.identity.clientId}</code>
            <br />
            主机名：{st.identity.host}
            {st.http ? (
              <>
                <br />
                {st.http.via === "server"
                  ? `上报入口：主服务 /api/cluster/report（端口 ${st.http.port}）`
                  : `上报入口：端口 ${st.http.port}${st.http.running ? "（监听中）" : "（未启动）"}`}
              </>
            ) : null}
          </div>
        )}

        {note && (
          <div className="hint" style={{ marginTop: 8 }}>
            {note}
          </div>
        )}
      </AppCard>

      {/* —— 运行状态：报告结果 + 各机在线情况（启用时才有意义）—— */}
      {role !== "off" && st?.state && (
        <AppCard padding={16} style={{ marginTop: 12 }}>
          <div className="block-title" style={{ marginBottom: 8 }}>
            运行状态
          </div>
          <div className="hint">
            角色：{st.state.role === "hub" ? "汇总机" : "客户端"}
            {" · "}
            累计报告 {st.state.reportCount} 次
            {role === "client" ? ` · 累计上报 ${st.state.pushCount} 次` : ""}
          </div>
          {st.state.lastReportAt && (
            <div className="hint">
              最后报告：{new Date(st.state.lastReportAt).toLocaleString("zh-CN", { hour12: false })}
              {" · "}
              {st.state.lastReportOk ? (
                <span style={{ color: "var(--ok, #35c88f)" }}>成功</span>
              ) : (
                <span style={{ color: "var(--danger, #ff6b6b)" }}>
                  失败{st.state.lastReportError ? `：${st.state.lastReportError}` : ""}
                </span>
              )}
            </div>
          )}
          {role === "client" && st.state.lastPushAt && (
            <div className="hint">
              最后上报：{new Date(st.state.lastPushAt).toLocaleString("zh-CN", { hour12: false })}
              {" · "}
              {st.state.lastPushOk ? (
                <span style={{ color: "var(--ok, #35c88f)" }}>成功</span>
              ) : (
                <span style={{ color: "var(--danger, #ff6b6b)" }}>
                  失败{st.state.lastPushError ? `：${st.state.lastPushError}` : ""}
                </span>
              )}
            </div>
          )}

          {clients.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {clients.map((c) => (
                <div key={c.clientId} className="hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{c.online ? "🟢" : "🔴"}</span>
                  <span>{c.host || c.clientId.slice(0, 12)}</span>
                  <span>{c.isMe ? "（本机）" : ""}</span>
                  <span>
                    {c.at ? new Date(c.at).toLocaleTimeString("zh-CN", { hour12: false }) : "从未上报"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="field-row" style={{ marginTop: 12 }}>
            <GlassButton
              variant="plain"
              controlSize="small"
              disabled={busy}
              onClick={() => void run("刷新", () => api.clusterState?.())}
            >
              刷新状态
            </GlassButton>
            <GlassButton
              variant="plain"
              controlSize="small"
              disabled={busy}
              onClick={() =>
                void run("清空汇总表", async () => {
                  const r = await api.clusterClear?.();
                  return r;
                })
              }
            >
              清空汇总表
            </GlassButton>
          </div>
        </AppCard>
      )}
    </div>
  );
}
