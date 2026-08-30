"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/agent-fs";
import type {
  CloudAgentAttachment,
  CloudAgentContextSourceItem,
  ConversationTurn,
  SharedFileAttachment,
  TimelineItem,
  TimelineMemoryItem,
} from "@/lib/cloud-agent";
import { collectTurnSharedFiles, collectTurnSources } from "@/lib/cloud-agent";
import { ChatMarkdown } from "@/components/markdown/chat-markdown";
import { ToolActivity, type ActivityStep } from "./tool-activity";
import { AnswerSourcesSheet, AnswerSourcesTrigger } from "./answer-sources";

function isImageMime(mime: string, fileName: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(fileName);
}

function AttachmentChips({
  attachments,
  onOpenFile,
}: {
  attachments: CloudAgentAttachment[];
  onOpenFile?: (path: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {attachments.map((a) => (
        <button
          key={a.path}
          type="button"
          onClick={() => onOpenFile?.(a.path)}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title={a.path}
        >
          {a.kind === "image" ? (
            <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FileIcon className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="max-w-40 truncate">{a.name}</span>
        </button>
      ))}
    </div>
  );
}

function SharedFilePreview({ url, fileName }: { url: string; fileName: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="block border-b border-border/50 bg-background/40"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={fileName}
        className="max-h-64 w-full object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

/**
 * Agent 通过 get_file_url 分享的文件：左侧对齐的附件卡片。
 * 图片可预览；点击下载打开公开 URL；可选在工作区打开路径。
 */
function SharedFileCards({
  files,
  onOpenFile,
}: {
  files: SharedFileAttachment[];
  onOpenFile?: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex max-w-[min(100%,28rem)] flex-col gap-2">
      {files.map((f) => {
        const image = isImageMime(f.mimeType, f.fileName);
        return (
          <div
            key={f.shareId || f.url}
            className="overflow-hidden rounded-lg border border-border/70 bg-muted/20"
          >
            {image ? <SharedFilePreview url={f.url} fileName={f.fileName} /> : null}
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
                {image ? (
                  <ImageIcon className="h-4 w-4" />
                ) : (
                  <FileIcon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-medium text-foreground hover:underline"
                  title={f.fileName}
                >
                  {f.fileName}
                </a>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                  {f.sizeBytes > 0 ? <span>{formatSize(f.sizeBytes)}</span> : null}
                  {f.path ? (
                    onOpenFile ? (
                      <button
                        type="button"
                        className="max-w-[12rem] truncate underline decoration-border underline-offset-2 hover:text-foreground"
                        onClick={() => onOpenFile(f.path)}
                        title="在工作区打开"
                      >
                        {f.path}
                      </button>
                    ) : (
                      <span className="max-w-[12rem] truncate font-mono">{f.path}</span>
                    )
                  ) : null}
                </div>
              </div>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                download={f.fileName}
                aria-label={`下载 ${f.fileName}`}
                className={cn(
                  buttonVariants({ size: "icon-sm", variant: "ghost" }),
                  "size-8 shrink-0 text-muted-foreground",
                )}
                title="下载"
              >
                <Download className="size-3.5" />
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中…",
  thinking: "思考中…",
  streaming: "生成中…",
  tool: "使用工具…",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7 text-muted-foreground"
            aria-label="复制"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          />
        }
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "已复制" : "复制"}</TooltipContent>
    </Tooltip>
  );
}

function Pager({
  index,
  total,
  onSelect,
  disabled,
}: {
  index: number;
  total: number;
  onSelect: (nextIndex: number) => void;
  disabled?: boolean;
}) {
  if (total <= 1) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={disabled || index <= 0}
        onClick={() => onSelect(index - 1)}
        aria-label="上一个"
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-8 text-center tabular-nums">
        {index + 1}/{total}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={disabled || index >= total - 1}
        onClick={() => onSelect(index + 1)}
        aria-label="下一个"
      >
        <ChevronRight />
      </Button>
    </span>
  );
}

function MemoryChip({ items }: { items: TimelineMemoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-muted-foreground"
            aria-label="已更新记忆"
          />
        }
      >
        <BookmarkCheck className="size-3.5" />
        <span>已更新记忆</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <ul className="list-disc space-y-1 pl-4">
          {items.map((m, i) => (
            <li key={m.id ?? i}>{m.content}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** 回答下方统一操作栏：复制 / 重新生成 / 来源 / 记忆 / 变体切换 */
function AnswerToolbar({
  copyText,
  sources,
  memoryItems,
  canAct,
  runActive,
  showRegenerate,
  variants,
  variantIndex,
  onRegenerate,
  onSelectVariant,
  onOpenSources,
}: {
  copyText: string;
  sources: CloudAgentContextSourceItem[];
  memoryItems: TimelineMemoryItem[];
  canAct: boolean;
  runActive: boolean;
  showRegenerate: boolean;
  variants: string[];
  variantIndex: number;
  onRegenerate: () => void;
  onSelectVariant: (runId: string) => void;
  onOpenSources: () => void;
}) {
  const hasLeft =
    Boolean(copyText) ||
    showRegenerate ||
    sources.length > 0 ||
    memoryItems.length > 0;
  const hasRight = variants.length > 1;
  if (!hasLeft && !hasRight) return null;

  return (
    <div className="flex flex-wrap items-center gap-0.5 pt-1.5">
      <div className="flex flex-wrap items-center gap-0.5">
        <CopyButton text={copyText} />
        {showRegenerate && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  aria-label="重新生成"
                  disabled={!canAct}
                  onClick={onRegenerate}
                />
              }
            >
              <RefreshCw className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>重新生成</TooltipContent>
          </Tooltip>
        )}
        <AnswerSourcesTrigger count={sources.length} onClick={onOpenSources} />
        <MemoryChip items={memoryItems} />
      </div>
      {hasLeft && hasRight ? (
        <Separator orientation="vertical" className="mx-1 h-4" />
      ) : null}
      <Pager
        index={variantIndex}
        total={variants.length}
        disabled={runActive}
        onSelect={(i) => {
          const target = variants[i];
          if (target) onSelectVariant(target);
        }}
      />
    </div>
  );
}

function elicitationContent(
  fields: Array<{ id: string; type: string; required?: boolean }>,
  values: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.id] ?? "";
    if (f.type === "boolean") {
      content[f.id] = raw === "true";
      continue;
    }
    if ((f.type === "number" || f.type === "integer") && raw !== "") {
      const n = Number(raw);
      if (!Number.isNaN(n)) content[f.id] = n;
      continue;
    }
    if (raw !== "" || f.required) content[f.id] = raw;
  }
  return content;
}

function ElicitationCard({
  item,
  onElicitation,
}: {
  item: Extract<TimelineItem, { kind: "elicitation" }>;
  onElicitation?: (requestId: string, cancelled?: boolean, content?: unknown) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = item.fields ?? [];
  return (
    <div className="my-2 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
      <div className="font-medium">
        {item.message || (item.mode === "url" ? "需要打开链接" : "需要补充信息")}
      </div>
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-xs text-primary underline"
        >
          {item.url}
        </a>
      ) : null}
      {item.resolved ? (
        <div className="text-xs text-muted-foreground">
          {item.resolved.cancelled ? "已取消" : "已提交"}
        </div>
      ) : (
        <>
          {fields.map((f) => (
            <label key={f.id} className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                {f.title || f.id}
                {f.required ? " *" : ""}
              </span>
              {f.type === "boolean" ? (
                <Switch
                  checked={values[f.id] === "true"}
                  onCheckedChange={(v) =>
                    setValues((prev) => ({ ...prev, [f.id]: v ? "true" : "false" }))
                  }
                  aria-label={f.title || f.id}
                />
              ) : f.options && f.options.length > 0 ? (
                <Select
                  value={values[f.id] ?? f.options[0] ?? ""}
                  onValueChange={(v) => {
                    if (v) setValues((prev) => ({ ...prev, [f.id]: v }));
                  }}
                  items={f.options.map((v) => ({ value: v, label: v }))}
                >
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={f.type === "number" || f.type === "integer" ? "number" : "text"}
                  className="max-w-72"
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
                />
              )}
            </label>
          ))}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                onElicitation?.(
                  item.requestId,
                  false,
                  fields.length ? elicitationContent(fields, values) : {},
                )
              }
            >
              {fields.length ? "提交" : "继续"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onElicitation?.(item.requestId, true)}
            >
              取消
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** 把回合条目渲染为块序列：连续思考+工具合并为一组，正文开始后自动收成首条 */
function renderRunItems(
  items: TimelineItem[],
  opts: {
    showStatus: boolean;
    canAct: boolean;
    onRetry: () => void;
    onOpenFile?: (path: string) => void;
    agentId?: string | null;
    sessionId?: string | null;
    onPermission?: (requestId: string, optionId?: string, cancelled?: boolean) => void;
    onElicitation?: (requestId: string, cancelled?: boolean, content?: unknown) => void;
  },
) {
  const blocks: ReactNode[] = [];
  let stepBuf: ActivityStep[] = [];
  const flushSteps = (key: string, autoCollapse: boolean) => {
    if (stepBuf.length === 0) return;
    blocks.push(
      <ToolActivity
        key={key}
        steps={stepBuf}
        autoCollapse={autoCollapse}
        onOpenFile={opts.onOpenFile}
        agentId={opts.agentId}
        sessionId={opts.sessionId}
      />,
    );
    stepBuf = [];
  };

  let lastStatus: Extract<TimelineItem, { kind: "status" }> | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === "status") {
      if (it.status !== "completed" && it.status !== "cancelled" && it.status !== "failed") {
        lastStatus = it;
      }
      break;
    }
  }

  // 只有时间线末尾仍是 reasoning（尚未进入工具/正文）时才算活动思考
  let activeReasoningSeq: number | null = null;
  let activeReasoningHasContent = false;
  if (opts.showStatus) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i]!;
      if (
        it.kind === "status" ||
        it.kind === "sources" ||
        it.kind === "memory" ||
        it.kind === "compaction"
      ) {
        continue;
      }
      if (it.kind === "reasoning") {
        activeReasoningSeq = it.seq;
        activeReasoningHasContent = Boolean(it.content.trim());
      }
      break;
    }
  }

  for (const it of items) {
    if (it.kind === "tool") {
      // 成功的 get_file_url 由 SharedFileCards 以附件样式展示，避免工具行重复
      const baseName = it.call.name.replace(/^re_/, "");
      if (
        baseName === "get_file_url" &&
        it.call.status === "done" &&
        !it.call.isError
      ) {
        continue;
      }
      stepBuf.push({ kind: "tool", call: it.call });
      continue;
    }
    if (it.kind === "reasoning") {
      if (!it.content.trim()) continue;
      stepBuf.push({
        kind: "reasoning",
        id: `${it.id}-${it.seq}`,
        content: it.content,
        active: activeReasoningSeq === it.seq,
      });
      continue;
    }
    if (it.kind === "compaction") {
      stepBuf.push({
        kind: "compaction",
        id: `${it.id}-${it.seq}`,
        active: it.active,
        summary: it.summary,
        beforeChars: it.beforeChars,
        afterChars: it.afterChars,
        droppedMessages: it.droppedMessages,
        keptMessages: it.keptMessages,
        source: it.source,
        durationMs: it.durationMs,
        model: it.model,
        phase: it.phase,
        progress: it.progress,
        failed: it.failed,
      });
      continue;
    }
    // sources / memory 由 AnswerToolbar 统一展示
    // 压缩中的 status 已由 compaction 步骤表达，避免底部再叠一条
    if (it.kind === "status" || it.kind === "sources" || it.kind === "memory") continue;
    // 正文开始 → 收起刚结束的思考/工具组；历史回合一律收
    const collapseSteps =
      (it.kind === "assistant" && Boolean(it.content.trim())) || !opts.showStatus;
    flushSteps(`steps-${it.seq}`, collapseSteps);
    if (it.kind === "user") {
      // 运行中注入（steer）的用户消息：挂在当前回合时间线上的右对齐气泡
      blocks.push(
        <div
          key={`u-${it.id}-${it.seq}`}
          className="animate-rise mt-1.5 flex w-full flex-col items-end gap-1.5"
        >
          {it.attachments?.length ? (
            <AttachmentChips attachments={it.attachments} onOpenFile={opts.onOpenFile} />
          ) : null}
          <div className="max-w-[min(85%,36rem)] rounded-xl bg-muted/90 px-4 py-2.5 text-[15px] leading-7 tracking-[-0.01em] text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/6%)]">
            <div className="whitespace-pre-wrap break-words">{it.content}</div>
          </div>
        </div>,
      );
    } else if (it.kind === "assistant") {
      blocks.push(
        <div
          key={`a-${it.id}-${it.seq}`}
          className="mt-1.5 flex w-full flex-col items-start"
        >
          <ChatMarkdown content={it.content} final={it.final} fade={false} />
        </div>,
      );
    } else if (it.kind === "plan") {
      blocks.push(
        <ol
          key={`plan-${it.id}`}
          className="my-2 space-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
        >
          {it.entries.map((e, i) => (
            <li key={`${it.id}-${i}`} className="flex gap-2 text-muted-foreground">
              <span className="shrink-0 text-[11px] text-muted-foreground/60">{e.status ?? "pending"}</span>
              <span className="text-foreground">{e.content}</span>
            </li>
          ))}
        </ol>,
      );
    } else if (it.kind === "permission") {
      blocks.push(
        <div
          key={`perm-${it.id}`}
          className="my-2 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
        >
          <div className="font-medium">{it.title || "需要授权"}</div>
          {it.resolved ? (
            <div className="text-xs text-muted-foreground">
              {it.resolved.outcome === "selected" ? "已选择" : "已取消"}
              {it.resolved.optionName || it.resolved.optionId
                ? ` · ${it.resolved.optionName || it.resolved.optionId}`
                : ""}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {it.options.map((opt) => (
                <Button
                  key={opt.optionId}
                  type="button"
                  size="sm"
                  variant={String(opt.kind).startsWith("allow") ? "default" : "outline"}
                  onClick={() => opts.onPermission?.(it.requestId, opt.optionId)}
                >
                  {opt.name}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => opts.onPermission?.(it.requestId, undefined, true)}
              >
                取消
              </Button>
            </div>
          )}
        </div>,
      );
    } else if (it.kind === "elicitation") {
      blocks.push(
        <ElicitationCard
          key={`elic-${it.id}`}
          item={it}
          onElicitation={opts.onElicitation}
        />,
      );
    } else if (it.kind === "error") {
      blocks.push(
        <div
          key={`e-${it.id}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 break-words">{it.message}</span>
          {opts.canAct && (
            <Button size="sm" variant="outline" className="shrink-0" onClick={opts.onRetry}>
              重试
            </Button>
          )}
        </div>,
      );
    }
  }
  flushSteps("steps-tail", !opts.showStatus);

  if (opts.showStatus && lastStatus) {
    const compactingDetail =
      typeof lastStatus.detail === "string" &&
      /压缩上下文/.test(lastStatus.detail);
    // 活动思考行 / 压缩步骤已自带状态，避免底部再叠
    const skipStatus =
      compactingDetail ||
      (lastStatus.status === "thinking" && activeReasoningHasContent);
    if (!skipStatus) {
      blocks.push(
        <div
          key={`s-${lastStatus.id}`}
          className="animate-rise flex items-center gap-2 py-1 text-[13px] text-muted-foreground/85"
        >
          <span className="running-halo relative flex size-[18px] items-center justify-center">
            <span
              className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
              aria-hidden
            />
          </span>
          <span className="text-shimmer">
            {STATUS_LABEL[lastStatus.status] ?? `${lastStatus.status}…`}
            {lastStatus.status === "tool" && lastStatus.detail ? (
              <span className="font-mono"> {lastStatus.detail}</span>
            ) : null}
          </span>
        </div>,
      );
    }
  }

  if (blocks.length === 0) return null;
  return <div className="flex flex-col gap-0">{blocks}</div>;
}

function turnAssistantText(items: TimelineItem[]): string {
  let text = "";
  for (const it of items) {
    if (it.kind === "assistant" && it.final && it.content) text = it.content;
  }
  return text;
}

function turnMemoryItems(items: TimelineItem[]): TimelineMemoryItem[] {
  const out: TimelineMemoryItem[] = [];
  for (const it of items) {
    if (it.kind === "memory") out.push(...it.items);
  }
  return out;
}

const EMPTY_WELCOMES = [
  "有什么可以帮忙的？",
  "今天想聊点什么？",
  "我在，直接说就行。",
  "准备好了，你说。",
  "有什么想做的？",
  "需要我帮什么忙？",
  "从哪儿开始？",
  "说说你的想法。",
  "随时可以开始。",
  "想问什么都可以。",
  "我听着，你说。",
  "有什么新鲜事？",
  "今天做什么？",
  "把问题丢过来就行。",
  "在呢，怎么了？",
  "有事尽管开口。",
  "准备好听你讲了。",
  "聊聊看？",
  "先从哪一步来？",
  "有什么安排？",
];

function pickEmptyWelcome() {
  return EMPTY_WELCOMES[Math.floor(Math.random() * EMPTY_WELCOMES.length)]!;
}

export function ChatMessages({
  turns,
  runActive,
  activeRunId,
  agentName,
  agentId,
  sessionId,
  canAct,
  editingMessageId,
  onRegenerate,
  onEditStart,
  onSelectVariant,
  onSelectBranch,
  onOpenFile,
  onPermission,
  onElicitation,
}: {
  turns: ConversationTurn[];
  runActive: boolean;
  activeRunId?: string | null;
  agentName?: string;
  agentId?: string | null;
  sessionId?: string | null;
  canAct: boolean;
  /** 正在下方 Composer 编辑的消息 id */
  editingMessageId?: string | null;
  onRegenerate: (messageId: string) => void;
  /** 召回 Composer 编辑（复用附件/换行等完整能力） */
  onEditStart: (
    messageId: string,
    parentKey: string,
    content: string,
    attachments: CloudAgentAttachment[],
  ) => void;
  onSelectVariant: (messageId: string, runId: string) => void;
  onSelectBranch: (parentKey: string, messageId: string) => void;
  onOpenFile?: (path: string) => void;
  onPermission?: (requestId: string, optionId?: string, cancelled?: boolean) => void;
  onElicitation?: (requestId: string, cancelled?: boolean, content?: unknown) => void;
}) {
  const [sourcesFor, setSourcesFor] = useState<{
    messageId: string;
    items: CloudAgentContextSourceItem[];
  } | null>(null);
  const [welcome, setWelcome] = useState(EMPTY_WELCOMES[0]!);

  useEffect(() => {
    if (turns.length === 0) setWelcome(pickEmptyWelcome());
  }, [turns.length]);

  const sourcesOpen = sourcesFor != null;
  const activeSources = useMemo(() => sourcesFor?.items ?? [], [sourcesFor]);

  if (turns.length === 0) {
    return (
      <div className="mt-auto flex flex-col items-center px-6 pb-10">
        <p className="animate-rise max-w-lg text-center text-[1.65rem] font-medium leading-snug tracking-[-0.03em] text-foreground/88">
          {agentName ? welcome : "开始对话"}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-3 py-5 md:px-5 md:py-7">
        {turns.map((turn, ti) => {
          const isLast = ti === turns.length - 1;
          // 锚点用户消息单独渲染；运行中注入（steer）的用户消息保留在 runItems 里按序展示
          const runItems = turn.items.filter(
            (it) => !(it.kind === "user" && it.id === turn.message.id),
          );
          const userItem = turn.items.find(
            (it) => it.kind === "user" && it.id === turn.message.id,
          );
          const attachments =
            userItem?.kind === "user" ? (userItem.attachments ?? []) : [];
          const turnRunning = runActive && turn.activeRunId === activeRunId;
          const editing = editingMessageId === turn.message.id;
          const sources = collectTurnSources(runItems);
          const sharedFiles = collectTurnSharedFiles(runItems);
          const copyText = turnAssistantText(runItems);
          const memoryItems = turnMemoryItems(runItems);
          const showActions =
            !turnRunning &&
            (Boolean(copyText) ||
              sources.length > 0 ||
              memoryItems.length > 0 ||
              turn.variants.length > 1 ||
              (isLast && canAct));

          return (
            <div
              key={turn.message.id}
              id={`turn-${turn.message.id}`}
              className="animate-rise flex flex-col gap-3"
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
            >
              {turn.message.continue ? null : editing ? (
                <div className="animate-rise ml-auto flex items-center gap-2 rounded-full border border-primary/35 bg-primary/10 px-3 py-1.5 text-xs text-muted-foreground">
                  <Pencil className="size-3 shrink-0 text-primary" />
                  <span>正在下方输入框编辑这条消息</span>
                </div>
              ) : (
                <div className="group flex flex-col items-end gap-1.5">
                  <AttachmentChips attachments={attachments} onOpenFile={onOpenFile} />
                  <div className="flex items-end justify-end gap-1">
                    <div className="mb-0.5 flex items-center gap-0.5 max-md:opacity-70 md:translate-x-1.5 md:opacity-0 md:transition-[opacity,transform] md:duration-200 md:ease-fluid md:group-hover:translate-x-0 md:group-hover:opacity-100 md:focus-within:translate-x-0 md:focus-within:opacity-100">
                      <CopyButton text={turn.message.content} />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="size-7 text-muted-foreground"
                              aria-label="编辑"
                              disabled={!canAct || runActive}
                              onClick={() =>
                                onEditStart(
                                  turn.message.id,
                                  turn.message.parentKey,
                                  turn.message.content,
                                  attachments,
                                )
                              }
                            />
                          }
                        >
                          <Pencil className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipContent>编辑</TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="max-w-[min(85%,36rem)] rounded-xl bg-muted/90 px-4 py-2.5 text-[15px] leading-7 tracking-[-0.01em] text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/6%)]">
                      <div className="whitespace-pre-wrap break-words">
                        {turn.message.content}
                      </div>
                    </div>
                  </div>
                  {turn.siblings.length > 1 && (
                    <Pager
                      index={turn.siblingIndex}
                      total={turn.siblings.length}
                      disabled={runActive}
                      onSelect={(i) => {
                        const target = turn.siblings[i];
                        if (target) onSelectBranch(turn.message.parentKey, target);
                      }}
                    />
                  )}
                </div>
              )}

              {renderRunItems(runItems, {
                showStatus: turnRunning,
                canAct,
                onRetry: () => onRegenerate(turn.message.id),
                onOpenFile,
                agentId,
                sessionId,
                onPermission,
                onElicitation,
              })}

              {sharedFiles.length > 0 && (
                <SharedFileCards files={sharedFiles} onOpenFile={onOpenFile} />
              )}

              {showActions && (
                <AnswerToolbar
                  copyText={copyText}
                  sources={sources}
                  memoryItems={memoryItems}
                  canAct={canAct}
                  runActive={runActive}
                  showRegenerate={canAct && !turnRunning && !turn.message.continue}
                  variants={turn.variants}
                  variantIndex={turn.variantIndex}
                  onRegenerate={() => onRegenerate(turn.message.id)}
                  onSelectVariant={(runId) => onSelectVariant(turn.message.id, runId)}
                  onOpenSources={() => setSourcesFor({ messageId: turn.message.id, items: sources })}
                />
              )}
            </div>
          );
        })}
      </div>

      <AnswerSourcesSheet
        open={sourcesOpen}
        onOpenChange={(open) => {
          if (!open) setSourcesFor(null);
        }}
        items={activeSources}
        onOpenFile={onOpenFile}
      />
    </>
  );
}
