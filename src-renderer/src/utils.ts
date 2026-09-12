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
