"use client";

import { useState, type ReactNode } from "react";
import MarkdownRender from "markstream-react";
import {
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  File as FileIcon,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  CloudAgentAttachment,
  ConversationTurn,
  TimelineItem,
  TimelineToolCall,
} from "@/lib/cloud-agent";
import { ToolActivity } from "./tool-activity";

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
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="h-6 w-6 text-muted-foreground/70 hover:text-foreground"
      aria-label="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
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
    <span className="inline-flex items-center text-xs text-muted-foreground/80">
      <Button
        size="icon-sm"
        variant="ghost"
        className="h-5 w-5"
        disabled={disabled || index <= 0}
        onClick={() => onSelect(index - 1)}
        aria-label="上一个"
      >
        <ChevronLeft className="h-3 w-3" />
      </Button>
      <span className="tabular-nums">
        {index + 1}/{total}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="h-5 w-5"
        disabled={disabled || index >= total - 1}
        onClick={() => onSelect(index + 1)}
        aria-label="下一个"
      >
        <ChevronRight className="h-3 w-3" />
      </Button>
    </span>
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
      toolBuf.push(it.call);
      continue;
    }
    if (it.kind === "status") continue;
    flushTools(`tools-${it.seq}`);
    if (it.kind === "assistant") {
      blocks.push(
        <div key={`a-${it.id}-${it.seq}`} className="group/msg flex flex-col items-start">
          <div className={MD_CLASS}>
            <MarkdownRender content={it.content} final={it.final} fade={false} />
          </div>
          {it.final && it.content && (
            <div className="max-md:opacity-70 md:opacity-0 md:transition-opacity md:group-hover/msg:opacity-100">
              <CopyButton text={it.content} />
            </div>
          )}
        </div>,
      );
    } else if (it.kind === "memory") {
      blocks.push(
        <Tooltip key={`m-${it.id}`}>
          <TooltipTrigger
            render={
              <div className="inline-flex w-fit cursor-default items-center gap-1 text-xs text-muted-foreground/70" />
            }
          >
            <BookmarkCheck className="h-3 w-3" />
            已更新记忆
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            <ul className="list-disc space-y-1 pl-4">
              {it.items.map((m, i) => (
                <li key={m.id ?? i}>{m.content}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>,
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
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>
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

  if (turns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
        <p className="text-xl font-medium text-foreground/80">
          {agentName ? `有什么可以帮忙的？` : "开始对话"}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 md:px-4 md:py-6">
      {turns.map((turn, ti) => {
        const isLast = ti === turns.length - 1;
        const runItems = turn.items.filter((it) => it.kind !== "user");
        const userItem = turn.items.find((it) => it.kind === "user");
        const attachments =
          userItem?.kind === "user" ? (userItem.attachments ?? []) : [];
        const turnRunning = runActive && turn.activeRunId === activeRunId;
        const editing = editingId === turn.message.id;

        return (
          <div key={turn.message.id} className="flex flex-col gap-2.5">
            {editing ? (
              <div className="ml-auto w-full max-w-[85%] rounded-2xl border border-border bg-muted/20 p-2">
                <Textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="min-h-[3rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingId(null);
                    if (e.key === "Enter" && !e.shiftKey) {
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
                  <div className="mb-0.5 flex max-md:opacity-70 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                    <CopyButton text={turn.message.content} />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground/70 hover:text-foreground"
                      aria-label="编辑"
                      disabled={!canAct}
                      onClick={() => {
                        setEditingId(turn.message.id);
                        setDraft(turn.message.content);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
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

            {(turn.variants.length > 1 || (isLast && canAct && !turnRunning)) && (
              <div className="-mt-1 flex items-center gap-1">
                <Pager
                  index={turn.variantIndex}
                  total={turn.variants.length}
                  disabled={runActive}
                  onSelect={(i) => {
                    const target = turn.variants[i];
                    if (target) onSelectVariant(turn.message.id, target);
                  }}
                />
                {canAct && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="h-6 w-6 text-muted-foreground/70 hover:text-foreground"
                          aria-label="重新生成"
                          onClick={() => onRegenerate(turn.message.id)}
                        />
                      }
                    >
                      <RefreshCw className="h-3 w-3" />
                    </TooltipTrigger>
                    <TooltipContent>重新生成</TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
