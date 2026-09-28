/**
 * 把一言对象渲染成一行展示文本：「正文 —— 作者」。
 *
 * 与 src/hitokoto.js 的 format() 保持同构（后端推送用的也是这个格式），
 * 界面和推送必须长得一样，否则用户会以为是两套东西。
 * 作者优先取 fromWho（人物）；没有时退回 from（作品名）；都没有就只显示正文。
 *
 * @param q 后端返回的一言，null/残缺一律返回空串（界面据此隐藏）
 */
export function formatQuote(q: { text?: string; from?: string; fromWho?: string } | null | undefined): string {
  if (!q || typeof q !== "object") return "";
  const text = String(q.text || "").trim();
  if (!text) return "";
  const author = String(q.fromWho || q.from || "").trim();
  return author ? `${text} —— ${author}` : text;
}

/**
 * 深合并。
 *
 * 与 src/global-config.js 的 deepMerge 行为一致：
 * 数组整体替换而不是逐项合并，否则 schedule.windows 删掉的时间段会被"复活"。
 */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object") return base;

  // 任一侧是数组就整体替换（时间段列表、目标列表都依赖这个语义）
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      out[k] = mergeDeep(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
