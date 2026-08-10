/** 表格 / 列表通用的时间与数量格式化。 */

/** `3 分钟前` / `刚刚`；无值时返回 fallback */
export function formatRelative(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return fallback;
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 60_000) return "刚刚";
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)} 小时${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.floor(abs / 86_400_000)} 天${suffix}`;
  return new Date(iso).toLocaleDateString();
}

/** `8月10日 14:32` 形式的绝对时间，用于 title 提示 */
export function formatAbsolute(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 1234 → 1.2k */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
