import { useMemo, useState } from "react";
import { GlassButton, GlassSwitch } from "@ttqtt/liquid-glass-react";
import { AppCard, Empty, Input, Table, Tag, toast, type TableColumn } from "../components/liquidGlassCompat";
import { api, IS_WEB } from "../api/ipc";
import { useAppState } from "../hooks/useAppState";
import { AskTextModal } from "../components/AskTextModal";
import { WebLoginModal } from "../components/WebLoginModal";
import type { Account, AccountRunStatus } from "../types";

/** 千分位格式化（仪表盘大数字每三位加逗号；强制 en-US 分组，不随系统 locale 变化） */
const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");

/** 最近执行：20260831 → 08-31 */
function fmtLastRun(a: Account): string {
  const s = String(a.state?.lastRunDate || 0);
  return s.length === 8 ? `${s.slice(4, 6)}-${s.slice(6, 8)}` : "—";
}

/** 自动运行状态短文案 */
function schedText(a: Account): { text: string; color: "success" | "warning" | "default" } {
  const sd = a.state?.sched || {};
  if (sd.enable === false) return { text: "未启用", color: "default" };
  if (sd.dayDone) return { text: `已收工 ${sd.rounds || 0} 轮`, color: "success" };
  if (sd.mode === "daily") return { text: "每日定时", color: "default" };
  if (sd.mode === "windows") return { text: "时间段循环", color: "default" };
  return { text: `每 ${sd.intervalMinutes || 45} 分钟`, color: "default" };
}

/** 账号运行态指示：running 转圈 / waiting 排队；橙/红徽标在名字下方单独渲染 */
function NameIndicator({ status }: { status: AccountRunStatus | null }) {
  if (!status) return null;
  if (status.status === "running") {
    return (
      <span className="acc-working" title="正在工作">
        <span className="acc-spinner" aria-label="正在工作" />
      </span>
    );
  }
  if (status.status === "waiting") {
    return (
      <span className="acc-waiting" title="排队等待中">
        <span className="acc-wait-dot" />
        排队
      </span>
    );
  }
  return null;
}

/** 名字下方的问题徽标：橙色「需要注意」/ 红色「发生错误」，空闲不渲染 */
function IssueBadge({ status }: { status: AccountRunStatus | null }) {
  if (!status) return null;
  if (status.status === "warning") {
    return (
      <div className="acc-issue acc-issue-warn" title={status.reason || "需要注意"}>
        <span className="acc-issue-icon">!</span>需要注意
      </div>
    );
  }
  if (status.status === "error") {
    return (
      <div className="acc-issue acc-issue-err" title={status.reason || "发生错误"}>
        <span className="acc-issue-icon">✕</span>发生错误
      </div>
    );
  }
  return null;
}

export function Dashboard({ onOpenAccount }: { onOpenAccount?: (id: string) => void }) {
  const { accounts, stats, refreshAccounts, running, getAccountStatus } = useAppState();
  const [kw, setKw] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  /** 勾选要批量运行的账号 id */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return k ? accounts.filter((a) => a.name.toLowerCase().includes(k)) : accounts;
  }, [accounts, kw]);

  const allChecked = rows.length > 0 && rows.every((a) => selected.has(a.id));
  const someChecked = rows.some((a) => selected.has(a.id));

  const toggleOne = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of rows) {
        if (on) next.add(a.id);
        else next.delete(a.id);
      }
      return next;
    });
  };

  const onRun = async (id: string) => {
    const r = await api.run(id);
    if (!r.ok) toast.error(r.error || "运行失败");
    else toast.success("运行完成");
    await refreshAccounts();
  };

  const onRunSelected = async () => {
    const ids = accounts.filter((a) => selected.has(a.id)).map((a) => a.id);
    if (ids.length === 0) {
      toast.error("请先勾选要运行的账号");
      return;
    }
    const r = await api.runSelected(ids);
    if (!r.ok && !(r as { aborted?: boolean }).aborted) {
      toast.error(r.error || "运行失败");
    } else if ((r as { aborted?: boolean }).aborted) {
      toast.info("任务已停止");
    } else {
      toast.success("所选账号已全部运行完成");
    }
    await refreshAccounts();
  };

  const onToggle = async (a: Account, v: boolean) => {
    await api.setAccountEnabled(a.id, v);
    await refreshAccounts();
  };

  // 状态列「去登录」
  const [loggingInId, setLoggingInId] = useState<string | null>(null);
  // Web 模式下先弹窗确认 noVNC 操作步骤，再真正发起登录
  const [loginConfirm, setLoginConfirm] = useState<Account | null>(null);

  const doLogin = async (a: Account) => {
    setLoggingInId(a.id);
    try {
      const r = await api.login(a.id);
      if (!r.ok) {
        toast.error(r.error || r.message || "登录失败");
        await refreshAccounts();
        return;
      }
      // 首次登录成功后自动同步一次账户信息（Cookie→积分→阅读进度），免去手动点「刷新状态」
      toast.success("登录成功，正在同步账户信息…");
      const rs = await api.sync(a.id);
      if (!rs.ok) toast.info(rs.error || "自动同步失败，可手动点「刷新状态」重试");
      else toast.success(rs.message || "账户信息已同步");
      await refreshAccounts();
    } catch (e) {
      toast.error((e as Error)?.message || "登录失败");
    } finally {
      setLoggingInId(null);
    }
  };

  const onLogin = (a: Account) => {
    if (IS_WEB) {
      setLoginConfirm(a);
    } else {
      void doLogin(a);
    }
  };

  const onLoginConfirm = () => {
    const a = loginConfirm;
    setLoginConfirm(null);
    if (!a) return;
    const novncUrl = `${location.protocol}//${location.hostname}:6080/vnc.html`;
    window.open(novncUrl, "_blank");
    void doLogin(a);
  };

  const onAdd = async (name: string) => {
    const r = await api.createAccount(name);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    toast.success(`已创建账户「${name}」`);
    await refreshAccounts();
  };

  // 列直接每次渲染计算：复选框/全选依赖最新的过滤结果，useMemo 反而易闭包过期
  const columns: TableColumn<Account>[] = [
      {
        key: "select",
        title: (
          <input
            type="checkbox"
            className="acc-check acc-check-all"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = !allChecked && someChecked;
            }}
            onChange={(e) => toggleAll(e.target.checked)}
            aria-label="全选当前账号"
          />
        ),
        width: 40,
        render: (a) => (
          <input
            type="checkbox"
            className="acc-check"
            checked={selected.has(a.id)}
            onChange={(e) => toggleOne(a.id, e.target.checked)}
            aria-label={`选择账号 ${a.name}`}
          />
        ),
      },
      {
        key: "name",
        title: "账号",
        render: (a) => {
          const st = getAccountStatus(a.id);
          return (
            <div
              onClick={() => onOpenAccount?.(a.id)}
              style={{ display: "flex", alignItems: "flex-start", gap: 9, minWidth: 0, cursor: "pointer" }}
              title="打开账号详情"
              role="button"
            >
              {/* 头像与行内其它控件同用 32px 一档（去登录/操作按钮/开关轨道都是 32 高），
                  不再单独压小 + marginTop 错位 */}
              <span className="nav-logo" style={{ flex: "0 0 auto" }}>
                {a.name.slice(0, 1).toUpperCase()}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 500 }}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
                  <NameIndicator status={st} />
                </div>
                <div className="hint">
                  {a.id.slice(0, 8)} · {a.useGlobal ? "遵循全局" : "独立设置"}
                </div>
                <IssueBadge status={st} />
              </div>
            </div>
          );
        },
      },
      {
        key: "loggedIn",
        title: "状态",
        width: 96,
        render: (a) => {
          const s = a.state || {};
          if (s.loggedIn) {
            return (
              <Tag color="success" size="sm">
                已登录
              </Tag>
            );
          }
          // 首次创建、从未登录过：状态位直接给「去登录」按钮
          if (!s.hasRefreshToken) {
            return (
              <GlassButton variant="glassProminent" controlSize="small"
                onClick={() => void onLogin(a)}
                disabled={running || loggingInId === a.id}
                title="弹出浏览器完成MS授权登录"
              >
                {loggingInId === a.id ? "登录中…" : "去登录"}
              </GlassButton>
            );
          }
          // 授权过但 Cookie 待同步：保持原来的「未登录」提示（详情页可点 ⟳ 刷新状态）
          return (
            <Tag color="warning" size="sm">
              未登录
            </Tag>
          );
        },
      },
      {
        key: "todayPoints",
        title: "今日积分",
        width: 86,
        align: "right",
        sortable: true,
        sorter: (x, y) => (x.state?.todayPoints || 0) - (y.state?.todayPoints || 0),
        render: (a) => <span className="num">{fmtNum(a.state?.todayPoints)}</span>,
      },
      {
        key: "balance",
        title: "总积分",
        width: 92,
        align: "right",
        sortable: true,
        sorter: (x, y) => (x.state?.lastBalance || 0) - (y.state?.lastBalance || 0),
        render: (a) => <span className="num">{fmtNum(a.state?.lastBalance)}</span>,
      },
      {
        key: "pending",
        title: "待办任务",
        render: (a) => {
          const pending = a.state?.sched?.pending;
          if (Array.isArray(pending) && pending.length) {
            return (
              <Tag color="warning" size="sm">
                {pending.join("、")}
              </Tag>
            );
          }
          return (
            <Tag color="success" size="sm">
              全部完成
            </Tag>
          );
        },
      },
      {
        key: "sched",
        title: "自动运行",
        width: 118,
        render: (a) => {
          const s = schedText(a);
          return (
            <Tag color={s.color} size="sm">
              {s.text}
            </Tag>
          );
        },
      },
      {
        key: "lastRun",
        title: "最近执行",
        width: 88,
        render: (a) => <span className="dim num">{fmtLastRun(a)}</span>,
      },
      {
        key: "act",
        title: "操作",
        width: 180,
        align: "right",
        render: (a) => (
          <div className="account-actions">
            <GlassButton variant="glassProminent" controlSize="small" radius={9}
              onClick={() => void onRun(a.id)}
              disabled={running}
              title="运行此账号"
            >
              ▶
            </GlassButton>
            <GlassButton variant="glass" controlSize="small" radius={9}
              onClick={() => onOpenAccount?.(a.id)}
              title="查看详情"
            >
              ⋯
            </GlassButton>
            <GlassSwitch
              className="account-enabled-switch"
              checked={a.enabled}
              onCheckedChange={(v) => void onToggle(a, v)}
              aria-label="启用或停用此账户"
            />
          </div>
        ),
      },
  ];

  return (
    <>
      <div className="stat-row">
        <AppCard className="stat-inner" padding={14} radius={16}>
          <div className="stat-label">账号数量</div>
          <div className="stat-value">{stats?.total ?? 0}</div>
          <div className="stat-hint">已启用 {stats?.enabled ?? 0} 个</div>
        </AppCard>
        <AppCard className="stat-inner" padding={14} radius={16}>
          <div className="stat-label">已登录</div>
          <div className="stat-value">{stats?.loggedIn ?? 0}</div>
          <div className="stat-hint">Cookie 有效的账号</div>
        </AppCard>
        <AppCard className="stat-inner" padding={14} radius={16}>
          <div className="stat-label">今日积分</div>
          <div className="stat-value">{fmtNum(stats?.todayPoints)}</div>
          <div className="stat-hint">所有账号今日合计</div>
        </AppCard>
        <AppCard className="stat-inner" padding={14} radius={16}>
          <div className="stat-label">今日进度</div>
          <div className="stat-value">
            {stats?.dayDone ?? 0}/{stats?.enabled ?? 0}
          </div>
          <div className="stat-hint">已收工 / 已启用账号</div>
        </AppCard>
      </div>

      <div className="block">
        <div className="block-head">
          <div>
            <div className="block-title">账户列表</div>
            <div className="block-sub">勾选账号可批量串行运行，账号间随机间隔 20–60 秒</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              size="sm"
              placeholder="搜索账号名称…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              style={{ width: 160 }}
              aria-label="搜索账号"
            />
            <GlassButton variant="glassProminent" controlSize="small"
              onClick={() => void onRunSelected()}
              disabled={running || selected.size === 0}
              title={selected.size === 0 ? "先勾选要运行的账号" : "串行运行勾选账号"}
            >
              ▶ 运行选中{selected.size > 0 ? ` (${selected.size})` : ""}
            </GlassButton>
            <GlassButton variant="glass" controlSize="small" onClick={() => setAddOpen(true)}>
              ＋ 新增账号
            </GlassButton>
          </div>
        </div>

        {/* 账户列表与统计卡共用内容材质，文字不受控制层折射干扰。 */}
        <AppCard className="account-list-card" padding={16} radius={16}>
          <Table
            columns={columns}
            data={rows}
            rowKey="id"
            size="sm"
            emptyText={
              accounts.length === 0 ? (
                <Empty
                  image="🛰️"
                  title="还没有账户"
                  description="点击「＋ 新增账号」创建第一个，每个账号拥有独立的登录状态与浏览器环境"
                />
              ) : (
                "没有匹配的账户"
              )
            }
          />
        </AppCard>
      </div>

      <AskTextModal
        open={addOpen}
        title="新增账号"
        label="给这个账号起个名字，便于区分（可随时重命名）"
        placeholder="例如：主账号"
        okText="创建"
        onOk={onAdd}
        onClose={() => setAddOpen(false)}
      />

      <WebLoginModal
        open={!!loginConfirm}
        accountName={loginConfirm?.name}
        onCancel={() => setLoginConfirm(null)}
        onConfirm={onLoginConfirm}
      />
    </>
  );
}
