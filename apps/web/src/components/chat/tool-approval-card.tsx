"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingToolApproval } from "@/lib/tool-approvals";

type ApprovalDecision = { requestId: string; decision: "approved" | "denied"; alwaysAllow?: boolean };

export function ToolApprovalTray({ items, onResolve }: {
  items: PendingToolApproval[];
  onResolve: (input: ApprovalDecision) => Promise<unknown>;
}) {
  const [submitted, setSubmitted] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!items.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [items.length]);
  const pending = items.filter(item => !submitted.has(item.requestId) && !item.resolved
    && (!item.expiresAt || Date.parse(item.expiresAt) > now));
  const item = pending[0];
  if (!item) return null;
  return <aside aria-label="待审批工具调用" className="pointer-events-none absolute inset-x-4 bottom-full z-30 pb-3">
    <div className="mx-auto flex max-w-3xl justify-end">
      <div className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-border motion-safe:animate-rise">
        <div className="flex items-center justify-between px-3 pt-3 text-xs text-muted-foreground"><span>等待你的批准</span>{pending.length > 1 ? <span>还有 {pending.length - 1} 项</span> : null}</div>
        <ToolApprovalCard key={item.requestId} item={item} onResolve={async input => {
          await onResolve(input);
          setSubmitted(current => new Set(current).add(input.requestId));
        }} />
      </div>
    </div>
  </aside>;
}

export function ToolApprovalCard({ item, onResolve }: {
  item: PendingToolApproval;
  onResolve: (input: ApprovalDecision) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  let argumentsText = item.argumentsJson ?? "";
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    argumentsText = JSON.stringify(parsed, null, 2);
  } catch { /* Preserve non-JSON command text. */ }
  const summary = ["command", "cmd", "path", "url", "target", "computerId"].flatMap(key => typeof fields[key] === "string" ? [`${key}: ${fields[key]}`] : []);
  const expired = !!item.expiresAt && Date.parse(item.expiresAt) <= Date.now();
  const seconds = item.expiresAt ? Math.max(0, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 1000)) : null;
  async function resolve(decision: "approved" | "denied") {
    if (pending || expired) return;
    setPending(true);
    try { await onResolve({ requestId: item.requestId, decision, alwaysAllow: false }); }
    catch { /* The caller reports errors; keep the card available for retry. */ }
    finally { setPending(false); }
  }
  if (item.resolved || expired) return null;
  return <div className="max-h-[min(26rem,55dvh)] space-y-2.5 overflow-y-auto p-3 text-sm">
    <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-words font-medium">{item.title || item.qualifiedName || item.toolName || "工具调用"}</span></div>
    {summary.length || argumentsText ? <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{summary.length ? summary.join("\n") : argumentsText}</pre> : <p className="text-xs text-muted-foreground">未提供调用参数</p>}
    {item.ai?.degraded ? <p className="text-xs text-muted-foreground">AI 审批不可用，请人工确认。</p> : item.ai?.decision === "deny" ? <p className="text-xs text-muted-foreground">AI 建议拒绝{item.ai.rationale ? `：${item.ai.rationale}` : ""}</p> : item.reason === "ai_low_confidence" ? <p className="text-xs text-muted-foreground">AI 置信度不足，请人工确认。</p> : null}
    {argumentsText || item.ai ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer weight-hover">调用详情</summary>{argumentsText ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2 font-mono text-[11px] text-foreground">{argumentsText}</pre> : null}{item.ai ? <div className="mt-2 space-y-1"><p>{item.ai.model}</p>{Number.isFinite(item.ai.confidence) ? <p>置信度 {Math.round(item.ai.confidence * 100)}%</p> : null}{item.ai.rationale ? <p className="break-words">{item.ai.rationale}</p> : null}</div> : null}</details> : null}
    <div className="flex items-center gap-2">
      {seconds !== null ? <span className="mr-auto text-[11px] text-muted-foreground">{seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`}后超时</span> : <span className="mr-auto" />}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void resolve("denied")}>拒绝</Button>
      <Button size="sm" disabled={pending} onClick={() => void resolve("approved")}>{pending ? "处理中…" : "批准"}</Button>
    </div>
  </div>;
}
