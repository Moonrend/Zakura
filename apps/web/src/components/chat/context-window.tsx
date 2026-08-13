"use client";

import { Gauge, RefreshCw, Scissors } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ContextWindowInfo = {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  messageCount: number;
  toolResultCount: number;
  summaryCount: number;
  lastSummary?: string;
  lastCompactedAt?: string;
  lastSavedTokens?: number;
  systemSessionId?: string;
  /** measured=上游 prompt_tokens；model=有 contextLimit；estimated=纯估算 */
  source: "model" | "estimated" | "measured";
};

function formatNumber(n: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(n)));
}

function formatPercent(ratio: number): string {
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function ringTone(ratio: number): string {
  if (ratio >= 0.9) return "text-destructive";
  if (ratio >= 0.72) return "text-foreground";
  return "text-muted-foreground";
}

export function ContextWindowButton({
  info,
  open,
  disabled,
  compacting,
  onOpenChange,
  onCompact,
}: {
  info: ContextWindowInfo;
  open: boolean;
  disabled?: boolean;
  compacting?: boolean;
  onOpenChange: (open: boolean) => void;
  onCompact: () => void;
}) {
  const dash = 2 * Math.PI * 15;
  const progress = Math.min(1, Math.max(0, info.ratio));
  const offset = dash * (1 - progress);
  const saved = info.lastSavedTokens ?? 0;
  const canCompact = !disabled && info.messageCount > 4 && !compacting;

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            size="icon"
            variant="ghost"
            aria-label="内容窗口"
            disabled={disabled}
            onClick={() => onOpenChange(true)}
            className={cn("relative size-9 shrink-0 rounded-full", ringTone(info.ratio))}
          >
            <svg viewBox="0 0 36 36" aria-hidden className="absolute inset-0 size-full">
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="opacity-15"
              />
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={dash}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="origin-center -rotate-90 transition-[stroke-dashoffset] duration-300"
              />
            </svg>
            <Gauge className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>内容窗口 {formatPercent(info.ratio)}</TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>内容窗口</SheetTitle>
            <SheetDescription>
              当前对话进入模型前的上下文用量（CJK 感知估算；有上游 usage 时会校准）。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-5 text-sm">
            <div className="flex items-center gap-4">
              <div className="relative grid size-20 shrink-0 place-items-center">
                <svg viewBox="0 0 80 80" aria-hidden className="absolute inset-0 size-full">
                  <circle
                    cx="40"
                    cy="40"
                    r="32"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="6"
                    className="text-muted-foreground/15"
                  />
                  <circle
                    cx="40"
                    cy="40"
                    r="32"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="6"
                    strokeDasharray={2 * Math.PI * 32}
                    strokeDashoffset={2 * Math.PI * 32 * (1 - progress)}
                    strokeLinecap="round"
                    className={cn(
                      "origin-center -rotate-90 transition-[stroke-dashoffset] duration-300",
                      ringTone(info.ratio),
                    )}
                  />
                </svg>
                <span className="text-sm font-medium tabular-nums">
                  {formatPercent(info.ratio)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium">
                  {formatNumber(info.usedTokens)} / {formatNumber(info.limitTokens)}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {info.source === "measured"
                    ? "用量含上游 prompt 实测校准"
                    : info.source === "model"
                      ? "窗口来自模型元数据 · 用量为估算"
                      : "默认窗口 · 用量为估算"}
                </div>
              </div>
            </div>

            <div className="divide-y divide-border/70 rounded-lg border border-border/70">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-muted-foreground">消息</span>
                <span className="font-medium tabular-nums">
                  {formatNumber(info.messageCount)}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-muted-foreground">工具结果</span>
                <span className="font-medium tabular-nums">
                  {formatNumber(info.toolResultCount)}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-muted-foreground">摘要</span>
                <span className="font-medium tabular-nums">
                  {formatNumber(info.summaryCount)}
                </span>
              </div>
            </div>

            {info.lastSummary ? (
              <div className="rounded-lg border border-border/70 p-3">
                <div className="mb-1 text-xs text-muted-foreground">最近摘要</div>
                <p className="line-clamp-6 whitespace-pre-wrap leading-6">
                  {info.lastSummary}
                </p>
              </div>
            ) : null}

            {saved > 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Scissors className="size-3.5" />
                上次压缩约释放 {formatNumber(saved)} tokens
              </div>
            ) : null}

            {info.systemSessionId ? (
              <div className="text-xs text-muted-foreground">
                AI 调用输入/输出已记录为系统对话。
              </div>
            ) : null}

            <Button
              className="w-full"
              variant={info.ratio >= 0.72 ? "default" : "outline"}
              disabled={!canCompact}
              onClick={onCompact}
            >
              {compacting ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Scissors className="size-4" />
              )}
              压缩上下文
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
