"use client";

import { useMemo, useState } from "react";
import type { CloudAgentEvent } from "@zakura/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<string, string> = {
  user_message: "用户消息",
  run_start: "Run 开始",
  assistant_delta: "增量输出",
  assistant_message: "助手消息",
  tool_call_start: "工具开始",
  tool_call_args: "工具参数",
  tool_call_result: "工具结果",
  run_status: "状态",
  run_end: "Run 结束",
  run_error: "错误",
  run_log: "日志",
  memory_updated: "记忆更新",
  context_sources: "上下文来源",
  session_update: "会话更新",
};

function summarize(ev: CloudAgentEvent): string {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "user_message":
    case "assistant_message":
      return String(p.content ?? "").slice(0, 120);
    case "assistant_delta":
      return String(p.delta ?? "").slice(0, 120);
    case "tool_call_start":
      return String(p.title ?? p.name ?? "");
    case "tool_call_args":
      return String(p.arguments ?? "").slice(0, 120);
    case "tool_call_result": {
      const err = p.isError === true ? "失败 · " : "";
      const ms = typeof p.durationMs === "number" ? ` (${p.durationMs}ms)` : "";
      return `${err}${String(p.name ?? "")}${ms}: ${String(p.resultText ?? "").slice(0, 100)}`;
    }
    case "run_status":
      return `${String(p.status ?? "")}${p.detail ? ` · ${String(p.detail)}` : ""}`;
    case "run_log": {
      const data = p.data ? ` ${JSON.stringify(p.data)}` : "";
      return `${String(p.message ?? "")}${data}`.slice(0, 200);
    }
    case "run_error":
      return String(p.message ?? "");
    case "memory_updated": {
      const items = Array.isArray(p.items) ? p.items : [];
      return `${items.length} 条`;
    }
    case "context_sources": {
      const items = Array.isArray(p.items) ? p.items : [];
      return `${items.length} 条`;
    }
    case "session_update":
      return String(p.title ?? "");
    default:
      return "";
  }
}

function levelClass(ev: CloudAgentEvent): string {
  const p = ev.payload as Record<string, unknown>;
  if (ev.type === "run_error") return "text-destructive";
  if (ev.type === "run_log" && p.level === "warn") return "text-amber-600 dark:text-amber-400";
  if (ev.type === "run_log" && p.level === "error") return "text-destructive";
  return "text-muted-foreground";
}

export function RunLogDrawer({
  open,
  onOpenChange,
  events,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: CloudAgentEvent[];
}) {
  const [verbose, setVerbose] = useState(false);

  const rows = useMemo(() => {
    if (verbose) return events;
    return events.filter(
      (e) =>
        e.type !== "assistant_delta" &&
        e.type !== "tool_call_args" &&
        e.type !== "run_status",
    );
  }, [events, verbose]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>运行日志</SheetTitle>
          <SheetDescription>本会话的完整事件记录，多设备实时同步。</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between px-1 pt-2">
          <div className="text-xs text-muted-foreground">{rows.length} 条事件</div>
          <div className="flex items-center gap-2">
            <Label htmlFor="log-verbose" className="text-xs text-muted-foreground">
              包含增量/状态事件
            </Label>
            <Switch id="log-verbose" checked={verbose} onCheckedChange={setVerbose} />
          </div>
        </div>
        <ScrollArea className="mt-2 min-h-0 flex-1 rounded-md border border-border/60">
          <div className="flex flex-col divide-y divide-border/40 font-mono text-xs">
            {rows.map((ev) => (
              <div key={ev.id} className="flex items-start gap-2 px-2 py-1.5">
                <span className="shrink-0 tabular-nums text-muted-foreground/60">
                  #{ev.seq}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground/60">
                  {new Date(ev.createdAt).toLocaleTimeString()}
                </span>
                <Badge
                  variant={
                    ev.type === "run_error"
                      ? "destructive"
                      : ev.type === "run_log"
                        ? "secondary"
                        : "outline"
                  }
                  className="shrink-0 px-1 py-0 text-[10px] font-normal"
                >
                  {TYPE_LABEL[ev.type] ?? ev.type}
                </Badge>
                <span className={cn("min-w-0 break-all", levelClass(ev))}>
                  {summarize(ev)}
                </span>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="px-3 py-8 text-center text-muted-foreground">暂无事件</div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
