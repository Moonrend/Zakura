"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimelineItem } from "@/lib/cloud-agent";

function remainingLabel(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const seconds = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return null;
  return seconds <= 0 ? "等待超时处理" : seconds < 60 ? `${seconds} 秒后超时` : `${Math.ceil(seconds / 60)} 分钟后超时`;
}
const resolutions = { approved: "已允许", denied: "已拒绝", timeout: "已超时", cancelled: "已取消" };

export function ToolApprovalCard({ item, onResolve }: {
  item: Extract<TimelineItem, { kind: "tool_approval" }>;
  onResolve?: (input: { requestId: string; decision: "approved" | "denied"; alwaysAllow?: boolean }) => void | Promise<unknown>;
}) {
  const [, tick] = useState(0);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (!item.expiresAt || item.resolved) return;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [item.expiresAt, item.resolved]);
  let argumentsText = item.argumentsJson ?? "";
  let fields: Record<string, unknown> = {};
  try { fields = JSON.parse(argumentsText); argumentsText = JSON.stringify(fields, null, 2); } catch { /* Preserve the actual command if it was not JSON. */ }
  const summary = ["command", "cmd", "path", "url", "target", "computerId"].flatMap(key => typeof fields?.[key] === "string" ? [`${key}: ${fields[key]}`] : []);
  const expired = !!item.expiresAt && Date.parse(item.expiresAt) <= Date.now();
  const deny = item.resolved?.decision === "denied" || item.resolved?.decision === "timeout";
  async function resolve(decision: "approved" | "denied") {
    if (pending || submitted || expired || !onResolve) return;
    setPending(true);
    try { await onResolve({ requestId: item.requestId, decision, alwaysAllow: false }); setSubmitted(true); }
    catch { /* The caller reports the error; retain the pending decision for retry. */ }
    finally { setPending(false); }
  }
  return <div className="surface-2 my-2 max-w-md animate-rise space-y-2.5 rounded-xl px-3 py-3 text-sm">
    <div className="flex items-start gap-2">{deny ? <ShieldX className="mt-0.5 size-4 shrink-0 text-destructive" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}<span className="min-w-0 break-words font-medium">{item.title || item.qualifiedName || item.toolName || "工具调用"}</span></div>
    {summary.length ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{summary.join("\n")}</pre> : argumentsText ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{argumentsText}</pre> : <p className="text-xs text-muted-foreground">未提供调用参数</p>}
    {item.ai?.degraded ? <p className="text-xs text-muted-foreground">AI 审批不可用，请人工确认。</p> : item.ai?.decision === "deny" ? <p className="text-xs text-destructive">AI 建议拒绝{item.ai.rationale ? `：${item.ai.rationale}` : ""}</p> : null}
    {argumentsText || item.ai ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer weight-hover">详情</summary>{argumentsText ? <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2 font-mono text-[11px] text-foreground">{argumentsText}</pre> : null}{item.ai ? <div className="mt-2 space-y-1"><p>{item.ai.model} · AI 建议{item.ai.decision === "allow" ? "允许" : "拒绝"}</p>{Number.isFinite(item.ai.confidence) ? <p>置信度 {Math.round(item.ai.confidence * 100)}%</p> : null}{item.ai.rationale ? <p className="break-words">{item.ai.rationale}</p> : null}</div> : null}</details> : null}
    {item.resolved ? <p className="text-xs text-muted-foreground">{resolutions[item.resolved.decision]}</p> : <>
      {item.expiresAt ? <p className="text-[11px] text-muted-foreground">{remainingLabel(item.expiresAt)}</p> : null}
      <div className="flex gap-2"><Button size="sm" disabled={pending || submitted || expired || !onResolve} onClick={() => void resolve("approved")}>允许一次</Button><Button size="sm" variant="outline" disabled={pending || submitted || expired || !onResolve} onClick={() => void resolve("denied")}>拒绝</Button></div>
    </>}
  </div>;
}
