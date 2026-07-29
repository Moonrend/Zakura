"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MarkdownRender from "markstream-react";
import {
  BookmarkCheck,
  Check,
  ChevronDown,
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
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
  TimelineToolCall,
} from "@/lib/cloud-agent";
import { collectTurnSharedFiles, collectTurnSources } from "@/lib/cloud-agent";
import { Disclosure } from "@/components/ui/disclosure";
import { ToolActivity } from "./tool-activity";
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
          className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
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
            className="overflow-hidden rounded-2xl border border-border/70 bg-muted/20"
          >
            {image ? <SharedFilePreview url={f.url} fileName={f.fileName} /> : null}
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-muted-foreground">
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

const MD_CLASS =
  "max-w-full min-w-0 break-words text-[15px] leading-7 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:text-[13px] [&_code]:font-mono [&_code]:text-[0.88em] [&_p]:my-2.5 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-[15px] [&_a]:underline [&_a]:underline-offset-2 [&_table]:my-2 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground";

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

function ReasoningBlock({
  id,
  content,
  active,
}: {
  id: string;
  content: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(active);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    if (active && !wasActive) {
      setOpen(true);
    } else if (!active && wasActive) {
      setOpen(false);
    }
    wasActiveRef.current = active;
  }, [active]);

  if (!content.trim()) return null;

  return (
    <div className="flex w-full max-w-[min(100%,42rem)] flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`reasoning-${id}`}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="group inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors duration-150 ease-fluid hover:bg-muted/60 hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform duration-200 ease-fluid",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        <span>{active ? "思考中" : "思考过程"}</span>
      </button>
      <Disclosure open={open} className="w-full" innerClassName="w-full">
        <div
          id={`reasoning-${id}`}
          className="mt-1 border-l-2 border-border/70 pl-3 text-[13px] leading-6 text-muted-foreground"
        >
          <div className={cn(MD_CLASS, "text-[13px] leading-6 text-muted-foreground")}>
            <MarkdownRender content={content} final={!active} fade={false} />
          </div>
        </div>
      </Disclosure>
    </div>
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
    <div className="flex flex-wrap items-center gap-0.5 pt-0.5">
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

/** 把回合条目渲染为块序列：连续 tool 合并为一组灰色文本行 */
function renderRunItems(
  items: TimelineItem[],
  opts: {
    showStatus: boolean;
    canAct: boolean;
    onRetry: () => void;
    onOpenFile?: (path: string) => void;
  },
) {
  const blocks: ReactNode[] = [];
  let toolBuf: TimelineToolCall[] = [];
  const flushTools = (key: string) => {
    if (toolBuf.length === 0) return;
    blocks.push(<ToolActivity key={key} calls={toolBuf} onOpenFile={opts.onOpenFile} />);
    toolBuf = [];
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
      toolBuf.push(it.call);
      continue;
    }
    // sources / memory 由 AnswerToolbar 统一展示
    if (it.kind === "status" || it.kind === "sources" || it.kind === "memory") continue;
    flushTools(`tools-${it.seq}`);
    if (it.kind === "assistant") {
      blocks.push(
        <div key={`a-${it.id}-${it.seq}`} className="flex flex-col items-start">
          <div className={MD_CLASS}>
            <MarkdownRender content={it.content} final={it.final} fade={false} />
          </div>
        </div>,
      );
    } else if (it.kind === "reasoning") {
      blocks.push(
        <ReasoningBlock
          key={`r-${it.id}-${it.seq}`}
          id={`${it.id}-${it.seq}`}
          content={it.content}
          active={opts.showStatus && it.runId === lastStatus?.runId}
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
  flushTools("tools-tail");

  if (opts.showStatus && lastStatus) {
    blocks.push(
      <div
        key={`s-${lastStatus.id}`}
        className="animate-rise flex items-center gap-2 text-xs"
      >
        <span className="running-halo relative flex size-3.5 items-center justify-center text-muted-foreground">
          <span
            className="size-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
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
  return blocks;
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

export function ChatMessages({
  turns,
  runActive,
  activeRunId,
  agentName,
  canAct,
  onRegenerate,
  onEditSend,
  onSelectVariant,
  onSelectBranch,
  onOpenFile,
}: {
  turns: ConversationTurn[];
  runActive: boolean;
  activeRunId?: string | null;
  agentName?: string;
  canAct: boolean;
  onRegenerate: (messageId: string) => void;
  onEditSend: (parentKey: string, content: string) => void;
  onSelectVariant: (messageId: string, runId: string) => void;
  onSelectBranch: (parentKey: string, messageId: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sourcesFor, setSourcesFor] = useState<{
    messageId: string;
    items: CloudAgentContextSourceItem[];
  } | null>(null);

  const sourcesOpen = sourcesFor != null;
  const activeSources = useMemo(() => sourcesFor?.items ?? [], [sourcesFor]);

  if (turns.length === 0) {
    return (
      <div className="mt-auto flex flex-col items-center px-6 pb-8">
        <p className="animate-rise text-2xl font-medium tracking-tight text-foreground/85">
          {agentName ? "有什么可以帮忙的？" : "开始对话"}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-4 md:px-4 md:py-6">
        {turns.map((turn, ti) => {
          const isLast = ti === turns.length - 1;
          const runItems = turn.items.filter((it) => it.kind !== "user");
          const userItem = turn.items.find((it) => it.kind === "user");
          const attachments =
            userItem?.kind === "user" ? (userItem.attachments ?? []) : [];
          const turnRunning = runActive && turn.activeRunId === activeRunId;
          const editing = editingId === turn.message.id;
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
            <div key={turn.message.id} className="animate-rise flex flex-col gap-2.5">
              {editing ? (
                <div className="animate-rise ml-auto w-full max-w-[85%] rounded-2xl border border-border bg-muted/20 p-2">
                  <Textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-h-[3rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingId(null);
                      if (e.key === "Enter" && !e.shiftKey) {
                        // 输入法组字中的回车是确认候选词，不能当作发送
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        if (draft.trim()) {
                          onEditSend(turn.message.parentKey, draft.trim());
                          setEditingId(null);
                        }
                      }
                    }}
                  />
                  <div className="flex justify-end gap-1.5 pt-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      disabled={!draft.trim() || !canAct}
                      onClick={() => {
                        onEditSend(turn.message.parentKey, draft.trim());
                        setEditingId(null);
                      }}
                    >
                      发送
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="group flex flex-col items-end gap-1">
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
                              disabled={!canAct}
                              onClick={() => {
                                setEditingId(turn.message.id);
                                setDraft(turn.message.content);
                              }}
                            />
                          }
                        >
                          <Pencil className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipContent>编辑</TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="max-w-[85%] rounded-3xl bg-muted px-4 py-2 text-[15px] leading-7 text-foreground">
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
                  showRegenerate={canAct && !turnRunning}
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
