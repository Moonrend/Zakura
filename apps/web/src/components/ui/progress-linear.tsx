"use client";

import { cn } from "@/lib/utils";

type ProgressLinearProps = {
  /** 0–100；不定进度时传 null / undefined 并设 indeterminate */
  value?: number | null;
  indeterminate?: boolean;
  className?: string;
  trackClassName?: string;
  barClassName?: string;
  /** 顶部贴边细条 */
  flush?: boolean;
};

export function ProgressLinear({
  value,
  indeterminate = false,
  className,
  trackClassName,
  barClassName,
  flush,
}: ProgressLinearProps) {
  const pct =
    typeof value === "number" ? Math.max(0, Math.min(100, value)) : indeterminate ? null : 0;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-busy={indeterminate || (pct != null && pct < 100)}
      className={cn(
        "w-full overflow-hidden bg-muted",
        flush ? "h-0.5" : "h-1 rounded-full",
        className,
        trackClassName,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          indeterminate
            ? "w-2/5 animate-progress-indeterminate bg-foreground/70"
            : "bg-foreground",
          barClassName,
        )}
        style={
          indeterminate || pct == null
            ? undefined
            : { width: `${pct}%` }
        }
      />
    </div>
  );
}

/**
 * 页面/区块加载占位：顶部吸附的不定进度细条，替代 Skeleton 占位块。
 * 无 wrapper、无间隔——直接渲染一条 h-0.5 的贴边线。
 */
export function PageLoading({ className }: { className?: string }) {
  return <ProgressLinear indeterminate flush className={className} />;
}
