import { useEffect, useMemo, useRef, useState } from "react";
import { AppCard, Select } from "../components/liquidGlassCompat";
import { BadgeIcon } from "../components/BadgeIcon";
import { BADGE_META, STATUS_LEGEND, badgesOf, type BadgeMeta } from "../data/badgeMeta";
import { api } from "../api/ipc";
import type { Account, CalendarDay, HistorySnapshot } from "../types";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** 每日格子的悬浮说明 */
function dayTitle(d: CalendarDay): string {
  const parts = [`${d.key}`];
  if (d.rest) parts.push("法定假日（休）");
  else if (d.workday) parts.push("调休上班（班）");
  if (d.festival) parts.push(d.festival);
  if (!d.hasRecord) parts.push("当天未运行");
  else if (d.status === "done") parts.push(`全部完成（${d.done}/${d.total}）`);
  else if (d.status === "partial") parts.push(`部分完成（${d.done}/${d.total}）`);
  else if (d.status === "error") parts.push("运行出错，无进度");
  else parts.push("未启动");
  if (d.points > 0) parts.push(`${d.points} 分`);
  return parts.join(" · ");
}

/** 图例里每档的计数 */
function countBy(days: CalendarDay[], key: CalendarDay["status"]) {
  return days.filter((d) => d.status === key).length;
}

export function CalendarPanel({ accounts }: { accounts: Account[] }) {
  const now = new Date();
  const [id, setId] = useState<string>("");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [snap, setSnap] = useState<HistorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  /** 展开/收起勋章墙 */
  const [showBadges, setShowBadges] = useState(true);

  // 账号列表变化时默认选第一个
  useEffect(() => {
    if (!id && accounts.length) setId(accounts[0].id);
    if (id && !accounts.some((a) => a.id === id) && accounts.length) setId(accounts[0].id);
  }, [accounts, id]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    api
      .getHistory(id, year, month)
      .then((s) => {
        if (alive) setSnap(s);
      })
      .catch(() => {
        if (alive) setSnap(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, year, month]);

  /** 翻月：month 超出 1-12 时自动进位/退位 */
  const shift = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  // 滚轮上下翻月 —— 只在月份导航条（‹ 年月 › / 回到本月）区域生效，
  // 日历格子区/页面滚动不再切月（用户反馈「翻月太容易误触发」）。
  // 用原生 listener 而不是 React onWheel：React 的合成 wheel 是被动监听，
  // 调 preventDefault 会告警且拦不住页面滚动；这里 passive:false + preventDefault，
  // 在月份栏滚动时彻底吃掉滚动，不带着页面一起滚。
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let lock = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      const t = Date.now();
      if (t - lock < 420) return; // 节流，避免一次滚动翻好几月
      lock = t;
      shift(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [year, month]);

  const days = snap?.month?.days || [];
  const badges = snap?.badges || {};
  const streak = snap?.streak || 0;

  /** 日历前置空格：周一为一周第一天 */
  const lead = useMemo(() => {
    if (!days.length) return 0;
    return (new Date(year, month - 1, 1).getDay() + 6) % 7;
  }, [days.length, year, month]);

  const options = accounts.map((a) => ({ label: a.name, value: a.id }));

  return (
    <div className="block">
      <div className="block-head">
        <div>
          <div className="block-title">签到日历与勋章墙</div>
          <div className="block-sub">按天记录每个账号的完成情况，含运行统计与成就勋章</div>
        </div>
      </div>

      <AppCard className="cal-card" padding={16} radius={16}>
        {/* ---- 顶部：账号切换 + 翻月 ---- */}
        <div className="cal-top">
          <div className="cal-pick">
            <span className="cal-pick-label">账号</span>
            <Select
              options={options}
              value={id}
              onChange={(v) => setId(v)}
              size="sm"
              aria-label="选择要查看的账号"
              placeholder={accounts.length ? undefined : "暂无账号"}
            />
          </div>
          <div className="cal-nav" ref={boxRef}>
            <button className="cal-nav-btn" onClick={() => shift(-1)} aria-label="上一月" title="上一月（也可在月份栏滚轮上滑）">
              ‹
            </button>
            <span className="cal-nav-title">
              {year} 年 {month} 月
            </span>
            <button className="cal-nav-btn" onClick={() => shift(1)} aria-label="下一月" title="下一月（也可在月份栏滚轮下滑）">
              ›
            </button>
            <button
              className="cal-nav-today"
              onClick={() => {
                setYear(now.getFullYear());
                setMonth(now.getMonth() + 1);
              }}
            >
              回到本月
            </button>
          </div>
        </div>

        {/* ---- 连续签到文案 ---- */}
        <div className="cal-streak">
          <span className="cal-streak-num">{streak}</span>
          <span className="cal-streak-txt">
            您已使用本软件连续签到 <b>{streak}</b> 天，继续努力
          </span>
        </div>

        {/* ---- 运行统计概览 ---- */}
        <div className="cal-stats">
          <StatItem label="累计完成" value={snap?.stats?.doneDays ?? 0} unit="天" />
          <StatItem label="最长连续" value={snap?.stats?.bestStreak ?? 0} unit="天" />
          <StatItem label="总积分" value={snap?.stats?.totalPoints ?? 0} />
          <StatItem label="获得勋章" value={snap?.stats?.badgeTotal ?? 0} unit="次" />
          <StatItem label="追踪天数" value={snap?.stats?.trackedDays ?? 0} unit="天" />
        </div>

        {/* ---- 日历网格 ---- */}
        <div className="cal-grid">
          {WEEK.map((w) => (
            <div key={w} className="cal-week">
              {w}
            </div>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <div key={`pad-${i}`} className="cal-cell cal-cell-pad" />
          ))}
          {days.map((d) => {
            const isBlue = !!d.rest || (!!d.weekend && !d.workday);
            return (
              <div
                key={d.key}
                className={`cal-cell cal-${d.status}${d.key === snap?.today ? " cal-today" : ""}${!d.hasRecord ? " cal-norecord" : ""}${isBlue ? " cal-blue" : ""}`}
                title={dayTitle(d)}
              >
                <span className="cal-day">{d.day}</span>
                <span className="cal-label">{d.label || "\u00A0"}</span>
                {d.rest ? <i className="cal-tag cal-tag-rest">休</i> : null}
                {d.workday ? <i className="cal-tag cal-tag-work">班</i> : null}
              </div>
            );
          })}
          {loading ? <div className="cal-loading">读取中…</div> : null}
        </div>

        {/* ---- 图例（带当月计数）---- */}
        <div className="cal-legend">
          {STATUS_LEGEND.map((l) => (
            <span key={l.key} className="cal-legend-item">
              <i className={`cal-dot cal-${l.cls}`} />
              {l.label}
              <b>{countBy(days, l.key)}</b>
            </span>
          ))}
          <span className="cal-legend-item cal-legend-perfect">
            {snap?.month?.perfect ? "🎉 本月全勤" : `本月全勤 ${snap?.month?.doneDays || 0}/${days.length}`}
          </span>
        </div>

        {/* ---- 勋章墙 ---- */}
        <div className="cal-badges-head">
          <span className="cal-badges-title">
            勋章墙
            <em>
              已获 {Object.values(badges).reduce((s, b) => s + (b.count || 0), 0)} 次 · 共 {BADGE_META.length} 枚
            </em>
          </span>
          <button className="cal-nav-today" onClick={() => setShowBadges((v) => !v)}>
            {showBadges ? "收起" : "展开"}
          </button>
        </div>

        {/* 勋章墙：常驻挂载，展开/收起用 grid-rows 0fr→1fr 过渡（带淡入上移） */}
        <div className={`cal-badges-wrap${showBadges ? " open" : ""}`}>
          <div className="cal-badges-inner">
            <div className="cal-badges">
              <BadgeGroup title="连续签到" list={badgesOf("streak")} badges={badges} />
              <BadgeGroup title="月度成就" list={badgesOf("perfect")} badges={badges} />
              <BadgeGroup title="节日专属" list={badgesOf("festival")} badges={badges} />
            </div>
          </div>
        </div>
      </AppCard>
    </div>
  );
}

/** 一组勋章 */
function BadgeGroup({
  title,
  list,
  badges,
}: {
  title: string;
  list: BadgeMeta[];
  badges: Record<string, { count: number; last: string }>;
}) {
  const got = list.filter((b) => (badges[b.id]?.count || 0) > 0).length;
  return (
    <div className="cal-bgroup">
      <div className="cal-bgroup-title">
        {title}
        <em>
          {got}/{list.length}
        </em>
      </div>
      <div className="cal-blist">
        {list.map((b) => {
          const rec = badges[b.id];
          const n = rec?.count || 0;
          return (
            <div key={b.id} className={`cal-badge${n > 0 ? " got" : ""}`} title={`${b.name} · ${b.desc}${n > 0 ? `\n已获得 ${n} 次${rec?.last ? `，最近 ${rec.last}` : ""}` : "\n尚未获得"}`}>
              <BadgeIcon iconKey={b.iconKey} tone={b.tone} size={30} dim={n === 0} />
              <span className="cal-bname">{b.name}</span>
              {n > 0 ? <span className="cal-bcount">×{n}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 一枚统计卡（大数字 + 单位 + 标签） */
function StatItem({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div className="cal-stat">
      <div className="cal-stat-value">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      <div className="cal-stat-label">{label}</div>
    </div>
  );
}
