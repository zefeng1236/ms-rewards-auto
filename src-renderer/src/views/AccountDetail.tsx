import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Empty,
  GlassSurface,
  Modal,
  Select,
  Switch,
  Tag,
  toast,
} from "@ttqtt/liquid-glass-react";
import { api } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { SettingsForm } from "../components/SettingsForm";
import { AskTextModal } from "../components/AskTextModal";
import { mergeDeep } from "../utils";
import type { AccountLogEntry, AppConfig, DeepPartial, GoalItem } from "../types";

/** 本账号专属日志面板：只显示该账号的日志（初始拉缓冲 + 实时订阅过滤） */
function AccountLogPanel({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [lines, setLines] = useState<AccountLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const buffer = useRef<AccountLogEntry[]>([]);

  // 切账号（key 变化会重挂载）时先拉一次该账号缓冲
  useEffect(() => {
    let alive = true;
    api
      .getAccountLogs(accountId)
      .then((list) => {
        if (alive) setLines(list || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [accountId]);

  // 实时订阅：只保留属于当前账号的条目，攒批刷新避免高频重渲染
  useEffect(() => {
    const off = api.onAccountLog((e) => {
      if (!e || String(e.accountId) !== String(accountId)) return;
      buffer.current.push(e);
    });
    const timer = window.setInterval(() => {
      if (buffer.current.length === 0) return;
      const incoming = buffer.current;
      buffer.current = [];
      setLines((prev) => {
        const next = prev.concat(incoming);
        return next.length > 1000 ? next.slice(next.length - 1000) : next;
      });
    }, 200);
    return () => {
      if (typeof off === "function") off();
      window.clearInterval(timer);
    };
  }, [accountId]);

  // 自动滚到底（用户手动上翻后暂停跟随）
  useEffect(() => {
    const el = bodyRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    setAutoScroll(atBottom);
  };

  return (
    <GlassSurface refraction="off" radius={14} material="clear" className="acc-log">
      <div className="acc-log-head">
        <span className="acc-log-title">「{accountName}」运行日志</span>
        <span className="dim" style={{ fontSize: 11 }}>
          仅显示当前账号 · {lines.length} 行
        </span>
      </div>
      <div className="acc-log-body" ref={bodyRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="acc-log-empty">暂无日志，点「立即运行」后这里只显示该账号的执行过程。</div>
        ) : (
          lines.map((e, i) => (
            <div key={i} className={`acc-log-line lvl-${(e.level || "").toLowerCase()}`}>
              {e.line}
            </div>
          ))
        )}
      </div>
    </GlassSurface>
  );
}

/** 今日任务卡片 */
function GoalCard({ goal, balance }: { goal: GoalItem; balance: number }) {
  const target = Math.max(1, Number(goal.target) || 1);
  const current = Math.max(0, Number(balance) || 0);
  const reward = String(goal.rewardName || "").trim();
  const count = Math.floor(current / target);
  const remain = target - (current % target || target);
  const text = current < target
    ? `已完成${current}还差${target - current}积分`
    : reward
    ? `当前已可兑换${count}个${reward}，距离下一个还剩${remain}积分`
    : `当前已达成${Math.round((current / target) * 10) / 10}倍目标`;
  return (
    <GlassSurface className="card-inner goal-dashboard-card" radius={14} title={`${goal.name}：${text}`}>
      <div className="card-label goal-card-label" title={goal.name}>{goal.name}</div>
      <div className="card-value small goal-card-value" title={text}>{text}</div>
    </GlassSurface>
  );
}

function TaskCard({
  label,
  value,
  sub,
  done,
  empty,
  small,
}: {
  label: string;
  value: string;
  sub?: string;
  done?: boolean;
  empty?: boolean;
  small?: boolean;
}) {
  return (
    <GlassSurface className="card-inner" radius={14}>
      <div className="card-label">{label}</div>
      <div
        className={`card-value${small ? " small" : ""} ${done ? "ok" : ""} ${empty ? "dim" : ""}`}
      >
        {value}
      </div>
      {sub ? <div className="card-sub">{sub}</div> : null}
    </GlassSurface>
  );
}

export function AccountDetail({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { accounts, refreshAccounts, running, getAccountStatus } = useAppState();
  const [globalCfg, setGlobalCfg] = useState<AppConfig | null>(null);
  const [overrides, setOverrides] = useState<DeepPartial<AppConfig> | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const account = useMemo(
    () => accounts.find((a) => a.id === selectedId) || accounts[0] || null,
    [accounts, selectedId]
  );

  const useGlobal = account?.useGlobal !== false;

  // 当前账号的运行态（决定转圈/停止按钮/禁用立即运行）
  const accStatus = account ? getAccountStatus(account.id) : null;
  const thisRunning = accStatus?.status === "running";
  const thisWaiting = accStatus?.status === "waiting";
  const issue =
    accStatus?.status === "warning"
      ? { cls: "acc-issue-warn", icon: "!", text: "需要注意" }
      : accStatus?.status === "error"
      ? { cls: "acc-issue-err", icon: "✕", text: "发生错误" }
      : null;

  const onStopThis = async () => {
    if (!account) return;
    setStopping(true);
    try {
      const r = await api.stopAccount(account.id);
      if (!r.ok) toast.error(r.error || "停止失败");
      else toast.info("正在停止此账号任务…");
    } finally {
      setStopping(false);
    }
  };

  // 独立设置模式下拉取覆盖值；遵循全局时不需要
  useEffect(() => {
    if (!account) return;
    if (useGlobal) {
      setOverrides(null);
      return;
    }
    let alive = true;
    api
      .getOverrides(account.id)
      .then((o) => {
        if (alive) setOverrides(o || {});
      })
      .catch(() => alive && setOverrides({}));
    return () => {
      alive = false;
    };
  }, [account?.id, useGlobal]);

  // 独立设置表单的显示值：未覆盖的字段以全局值为起点
  useEffect(() => {
    api
      .getGlobalConfig()
      .then(setGlobalCfg)
      .catch(() => setGlobalCfg(null));
  }, []);

  const formValue = useMemo<AppConfig | null>(() => {
    if (!account) return null;
    if (useGlobal) return account.config;
    const base = globalCfg || account.config;
    return overrides ? mergeDeep(base, overrides) : base;
  }, [account, useGlobal, globalCfg, overrides]);

  const saveOverrides = useCallback(
    async (patch: DeepPartial<AppConfig>) => {
      if (!account) return;
      await api.setConfig(account.id, patch);
      setOverrides((prev) => mergeDeep(prev || {}, patch));
      await refreshAccounts();
    },
    [account, refreshAccounts]
  );

  const onLogin = async () => {
    if (!account) return;
    setBusy("login");
    try {
      const r = await api.login(account.id);
      if (!r.ok) toast.error(r.error || "登录失败");
      else toast.success("登录成功");
      await refreshAccounts();
    } finally {
      setBusy(null);
    }
  };

  const onSync = async () => {
    if (!account) return;
    setBusy("sync");
    try {
      const r = await api.sync(account.id);
      if (!r.ok) toast.error(r.error || "刷新失败");
      else toast.success("状态已刷新");
      await refreshAccounts();
    } finally {
      setBusy(null);
    }
  };

  const onRun = async () => {
    if (!account) return;
    setBusy("run");
    try {
      const r = await api.run(account.id);
      if (!r.ok) toast.error(r.error || "运行失败");
      else toast.success("运行完成");
      await refreshAccounts();
    } finally {
      setBusy(null);
    }
  };

  const onRename = async (name: string) => {
    if (!account) return;
    await api.renameAccount(account.id, name);
    toast.success("已重命名");
    await refreshAccounts();
  };

  const onDelete = async () => {
    if (!account) return;
    const ok = await Modal.confirm({
      title: `删除账户「${account.name}」？`,
      content: "登录状态、配置与浏览器数据会一并清除，且不可恢复。",
      okText: "删除",
      cancelText: "取消",
      danger: true,
      locale: "zh-CN",
    });
    if (!ok) return;
    await api.removeAccount(account.id);
    toast.success("账户已删除");
    onSelect("");
    await refreshAccounts();
  };

  const onToggleUseGlobal = async (v: boolean) => {
    if (!account) return;
    await api.setUseGlobal(account.id, v);
    await refreshAccounts();
  };

  if (!account) {
    return (
      <Card>
        <Empty
          image="🛰️"
          title="还没有账户"
          description="先到仪表盘点「＋ 新增账号」创建一个"
        />
      </Card>
    );
  }

  const s = account.state || {};

  return (
    <>
      {/* ---- 账户选择 + 操作 ---- */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 220, flex: 1 }}>
            <Select
              value={account.id}
              options={accounts.map((a) => ({
                value: a.id,
                label: `${a.name}${(a.state?.sched?.dayDone ? " ✓" : "")} · ${
                  a.state?.loggedIn ? "已登录" : "未登录"
                } · ${a.state?.todayPoints || 0} 分`,
              }))}
              onChange={onSelect}
              size="sm"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`dot ${s.loggedIn ? "on" : "off"}`} />
            <span className="dim" style={{ fontSize: 12 }}>
              {s.loggedIn ? "已登录" : s.hasRefreshToken ? "已授权（Cookie 待同步）" : "未登录"}
            </span>
            {thisRunning && (
              <Tag size="sm" color="default">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="acc-spinner" style={{ width: 11, height: 11, borderWidth: 2 }} />
                  正在工作
                </span>
              </Tag>
            )}
            {thisWaiting && (
              <Tag size="sm" color="warning">
                排队等待
              </Tag>
            )}
            {s.sched?.nextRunText && (
              <Tag size="sm" color="default">
                下次 {s.sched.nextRunText}
              </Tag>
            )}
            {issue && (
              <span className={`acc-issue ${issue.cls}`} title={accStatus?.reason || issue.text}>
                <span className="acc-issue-icon">{issue.icon}</span>
                {issue.text}
                {accStatus?.reason ? `：${accStatus.reason}` : ""}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="accent"
              size="sm"
              onClick={onLogin}
              loading={busy === "login"}
              disabled={running}
            >
              授权登录
            </Button>
            <Button
              variant="glass"
              size="sm"
              onClick={onSync}
              loading={busy === "sync"}
              disabled={running}
            >
              ⟳ 刷新状态
            </Button>
            {/* 正在跑这个账号：立即运行换成停止此账号；排队中可直接移出队列 */}
            {thisRunning ? (
              <Button variant="danger" size="sm" onClick={() => void onStopThis()} loading={stopping}>
                ■ 停止此账号
              </Button>
            ) : (
              <Button
                variant="accent"
                size="sm"
                onClick={onRun}
                loading={busy === "run"}
                disabled={running}
                title={thisWaiting ? "该账号正在排队等待" : "仅运行当前账号"}
              >
                {thisWaiting ? "排队中…" : "立即运行"}
              </Button>
            )}
            {thisWaiting && (
              <Button variant="danger" size="sm" onClick={() => void onStopThis()} loading={stopping}>
                取消排队
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ---- 今日任务进度 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">今日任务进度</div>
            <div className="block-sub">
              数字来自服务器积分进度，✓ 表示今日已实际运行并同步完成
            </div>
          </div>
        </div>
        <div className="cards">
          {(account.config?.goals?.enable !== false ? account.config.goals.items : [])
            .filter((g) => g.showDashboard !== false)
            .map((g, i) => <GoalCard key={`goal-${i}`} goal={g} balance={s.lastBalance || 0} />)}
          <TaskCard
            label="总积分"
            value={s.lastBalance ? String(s.lastBalance) : "--"}
            empty={!s.lastBalance}
          />
          <TaskCard
            label="今日合计"
            value={s.todayPoints ? String(s.todayPoints) : "--"}
            empty={!s.todayPoints}
          />
          <TaskCard
            label="签入"
            small
            value={s.signDone ? "完成" : s.signPoint ? String(s.signPoint) : "--"}
            sub={s.signDone ? `已完成 · ${s.signPoint || 0} 分` : undefined}
            done={!!s.signDone}
            empty={!s.signDone && !s.signPoint}
          />
          <TaskCard
            label="阅读"
            small
            value={
              s.readDone
                ? s.readArticlesTotal
                  ? `${s.readArticlesTotal}/${s.readArticlesTotal} 篇`
                  : "完成"
                : s.readArticlesTotal > 0
                ? `${s.readArticlesDone || 0}/${s.readArticlesTotal} 篇`
                : s.readPoint
                ? String(s.readPoint)
                : "--"
            }
            sub={
              s.readDone
                ? `已完成 · ${s.readPoint || 0} 分`
                : s.readArticlesTotal > 0
                ? `还需 ${Math.max(0, s.readArticlesTotal - (s.readArticlesDone || 0))} 篇 · ${
                    s.readPoint || 0
                  } 分`
                : undefined
            }
            done={!!s.readDone}
            empty={!s.readDone && !s.readArticlesTotal && !s.readPoint}
          />
          <TaskCard
            label="活动"
            small
            value={s.promosDone ? "完成" : s.promosPoint ? String(s.promosPoint) : "--"}
            sub={s.promosDone ? `已完成 · ${s.promosPoint || 0} 分` : undefined}
            done={!!s.promosDone}
            empty={!s.promosDone && !s.promosPoint}
          />
          <TaskCard
            label="搜索"
            small
            value={s.searchDone ? s.searchProgress || "完成" : s.searchProgress || "--"}
            sub={s.searchDone ? "已完成" : undefined}
            done={!!s.searchDone}
            empty={!s.searchDone && !s.searchProgress}
          />
          <TaskCard
            label="受限次数"
            small
            value={s.restrictedTimes ? String(s.restrictedTimes) : "--"}
            empty={!s.restrictedTimes}
          />
        </div>
      </div>

      {/* ---- 本账号运行日志（只显示当前账号） ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">运行日志</div>
            <div className="block-sub">这里只显示当前账号的执行过程；全局日志在底部「运行日志」面板</div>
          </div>
        </div>
        <AccountLogPanel key={account.id} accountId={account.id} accountName={account.name} />
      </div>

      {/* ---- 本账号设置 ---- */}
      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">本账号设置</div>
            <div className="block-sub">
              默认与全局设置保持一致，关闭下方开关可为此账号单独配置
            </div>
          </div>
        </div>

        <Card padding="md">
          <Switch
            checked={useGlobal}
            onCheckedChange={(v) => void onToggleUseGlobal(v)}
            aria-label="遵循全局设置"
          />{" "}
          <span style={{ marginLeft: 8 }}>遵循全局设置</span>
          <div className="hint" style={{ marginTop: 8 }}>
            {useGlobal
              ? "当前跟随全局设置。改动全局设置会同时影响此账号；到「全局设置」页调整即可。"
              : "当前使用独立设置，不受全局设置影响。未单独调整的项以切换时的全局值为起点。"}
          </div>

          {!useGlobal && formValue && (
            <div style={{ marginTop: 12 }}>
              <SettingsForm
                value={formValue}
                onChange={(patch) => void saveOverrides(patch)}
                onTestPush={async (notice) => {
                  const r = await api.testPush(notice);
                  if (r.ok === false) toast.error(r.error || "推送失败");
                  else toast.success("测试推送已发送，详见日志");
                }}
              />
            </div>
          )}
        </Card>
      </div>

      {/* ---- 账号管理 ---- */}
      <div className="block danger-zone">
        <div className="block-head">
          <div>
            <div className="block-title">账号管理</div>
            <div className="block-sub">删除后登录状态、配置与浏览器数据一并清除，不可恢复</div>
          </div>
        </div>
        <Card padding="md">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="glass" size="sm" onClick={() => setRenameOpen(true)}>
              ✎ 重命名
            </Button>
            <Button variant="danger" size="sm" onClick={() => void onDelete()}>
              删除此账户
            </Button>
          </div>
        </Card>
      </div>

      <AskTextModal
        open={renameOpen}
        title="重命名账户"
        placeholder="新的名称"
        defaultValue={account.name}
        okText="保存"
        onOk={onRename}
        onClose={() => setRenameOpen(false)}
      />
    </>
  );
}
