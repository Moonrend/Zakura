"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ShieldCheck, ShieldX } from "lucide-react";
import { TOOL_APPROVAL_REASON_LABEL, type ToolApprovalReason } from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";
import type { TimelineItem } from "@/lib/cloud-agent";

function remainingLabel(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "即将超时";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec} 秒后超时`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min} 分钟后超时`;
  return `${Math.ceil(min / 60)} 小时后超时`;
}

function prettyArgs(raw?: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const DENIED_RESOLUTION: Record<string, string> = {
  approved: "已允许",
  denied: "已拒绝",
  timeout: "已超时 · 自动拒绝",
  cancelled: "已取消",
};

/** AI 门控的 allow / deny 概率条（JEV choice 原语输出） */
function AiProbabilityBars({
  probabilities,
  decision,
  reduced,
}: {
  probabilities: Record<string, number>;
  decision: string;
  reduced: boolean;
}) {
  const options = useMemo(() => {
    const keys = ["allow", "deny"].filter((k) => typeof probabilities[k] === "number");
    if (keys.length === 0) return [];
    const total = keys.reduce((sum, k) => sum + (probabilities[k] ?? 0), 0) || 1;
    return keys.map((k) => ({
      key: k,
      pct: Math.round(((probabilities[k] ?? 0) / total) * 100),
    }));
  }, [probabilities]);
  if (options.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {options.map(({ key, pct }) => {
        const allow = key === "allow";
        const picked = key === decision;
        return (
          <div key={key} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className={cn("font-medium", picked ? "text-foreground" : "text-muted-foreground")}>
                {allow ? "允许" : "拒绝"}
                {picked ? "（AI 选择）" : ""}
              </span>
              <span className={cn("tabular-nums", picked ? "text-foreground" : "text-muted-foreground")}>
                {pct}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  allow ? "bg-primary" : "bg-destructive/70",
                  picked && allow && "bg-primary",
                )}
                initial={{ width: reduced ? `${pct}%` : "0%" }}
                animate={{ width: `${pct}%` }}
                transition={reduced ? { duration: 0 } : spring.slow}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ToolApprovalCard({
  item,
  onResolve,
}: {
  item: Extract<TimelineItem, { kind: "tool_approval" }>;
  onResolve?: (input: {
    requestId: string;
    decision: "approved" | "denied";
    alwaysAllow?: boolean;
  }) => void;
}) {
  const [tick, setTick] = useState(0);
  const [argsOpen, setArgsOpen] = useState(false);
  const reduced = useReducedMotion() ?? false;
  const ai = item.ai;

  useEffect(() => {
    if (!item.expiresAt || item.resolved) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [item.expiresAt, item.resolved]);

  const timeoutHint = remainingLabel(item.expiresAt);
  void tick;
  const args = prettyArgs(item.argumentsJson);
  const reasonLabel =
    TOOL_APPROVAL_REASON_LABEL[item.reason as ToolApprovalReason] ?? "策略要求确认";

  const resolvedText = item.resolved
    ? DENIED_RESOLUTION[item.resolved.decision] ?? item.resolved.decision
    : null;

  return (
    <div className="surface-2 my-2 max-w-md animate-rise space-y-2.5 rounded-xl px-3 py-3 text-sm">
      <div className="flex items-start gap-2">
        {item.resolved?.decision === "denied" || item.resolved?.decision === "timeout" ? (
          <ShieldX className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <ShieldCheck
            className={cn(
              "mt-0.5 size-4 shrink-0",
              item.resolved ? "text-primary" : "text-muted-foreground",
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium text-foreground">
              {item.title || item.qualifiedName || item.toolName}
            </span>
            <span className="rounded-full border border-border/50 bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground">
              {item.resolved?.alwaysAllow ? "已记住允许" : reasonLabel}
            </span>
          </div>
          {item.qualifiedName && item.title ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {item.qualifiedName}
            </div>
          ) : null}
        </div>
      </div>

      {ai ? (
        <div className="space-y-2 rounded-lg border border-border/50 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "rounded-full px-1.5 py-px font-medium",
                ai.decision === "allow"
                  ? "bg-primary/10 text-foreground"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              AI 建议{ai.decision === "allow" ? "允许" : "拒绝"}
            </span>
            {ai.model ? (
              <span className="rounded-full border border-border/50 px-1.5 py-px font-mono">
                {ai.model}
              </span>
            ) : null}
            {typeof ai.latencyMs === "number" ? (
              <span className="tabular-nums">{ai.latencyMs} ms</span>
            ) : null}
            {ai.degraded ? <span>（AI 不可用，降级人工）</span> : null}
          </div>
          <AiProbabilityBars
            probabilities={ai.probabilities ?? {}}
            decision={ai.decision}
            reduced={reduced}
          />
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>置信度</span>
            <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: reduced ? `${Math.round(ai.confidence * 100)}%` : "0%" }}
                animate={{ width: `${Math.round(ai.confidence * 100)}%` }}
                transition={reduced ? { duration: 0 } : spring.moderate}
              />
            </div>
            <span className="tabular-nums">{Math.round(ai.confidence * 100)}%</span>
            {ai.rationale ? <span className="truncate">· {ai.rationale}</span> : null}
          </div>
        </div>
      ) : null}

      {args ? (
        <div>
          <button
            type="button"
            onClick={() => setArgsOpen((v) => !v)}
            className="flex w-full items-center gap-1 rounded-md text-left text-[11px] text-muted-foreground transition-colors duration-150 ease-fluid hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3 transition-transform duration-200 ease-fluid",
                argsOpen && "rotate-180",
              )}
            />
            调用参数
          </button>
          <AnimatePresence initial={false}>
            {argsOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={reduced ? { duration: 0 } : spring.moderate}
                className="overflow-hidden"
              >
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {args}
                </pre>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      {item.resolved ? (
        <div className="text-xs text-muted-foreground">
          {resolvedText}
          {item.resolved.decidedBy === "user" ? " · 由你决定" : null}
        </div>
      ) : (
        <>
          {timeoutHint ? (
            <div className="text-[11px] text-muted-foreground">
              {timeoutHint} · 超时自动拒绝
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() => onResolve?.({ requestId: item.requestId, decision: "approved" })}
            >
              允许
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onResolve?.({
                  requestId: item.requestId,
                  decision: "approved",
                  alwaysAllow: true,
                })
              }
            >
              总是允许
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onResolve?.({ requestId: item.requestId, decision: "denied" })}
            >
              拒绝
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
