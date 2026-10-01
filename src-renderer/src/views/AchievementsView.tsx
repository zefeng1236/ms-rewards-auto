import { useAppState } from "../hooks/useAppState";
import { CalendarPanel } from "./CalendarPanel";

/**
 * 「成就与统计」独立页（用户 2026-09-30：把仪表盘里的签到日历搬出来单独成页）。
 *
 * 页面标题「成就与统计」由 App 的 VIEW_META 提供；本页只承载内容体：
 * 运行统计卡 + 签到日历（四态/农历/休班角标）+ 连续签到 + 勋章墙。
 * 账号切换、翻月、历史/勋章拉取都在 CalendarPanel 内自洽完成。
 */
export function AchievementsView() {
  const { accounts } = useAppState();
  return (
    <div className="achievements-view">
      <CalendarPanel accounts={accounts} />
    </div>
  );
}
