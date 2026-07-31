"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowUp, Brain, File as FileIcon, Paperclip, Square, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CloudAgentAttachment } from "@/lib/cloud-agent";
import { formatSize } from "@/lib/agent-fs";
import { ModelPicker, type ModelPickerItem } from "./model-picker";
import { ContextWindowButton, type ContextWindowInfo } from "./context-window";

/** 约 8 行后转为内部滚动 */
const MAX_TEXTAREA_HEIGHT = 208;

export type ComposerModelItem = ModelPickerItem;

export type ComposerReasoningValue = "default" | "off" | (string & {});

const REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

function reasoningLabel(value: string): string {
  const normalized = value.toLowerCase();
  return (
    REASONING_LABELS[normalized] ??
    value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function reasoningItemsFromLevels(
  levels?: readonly string[],
): Array<{ value: ComposerReasoningValue; label: string }> {
  if (!levels) return [{ value: "default", label: "默认" }];
  const items: Array<{ value: ComposerReasoningValue; label: string }> = [
    { value: "default", label: "默认" },
  ];
  const seen = new Set<string>(["default"]);
  for (const raw of levels) {
    const value = String(raw).trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (normalized === "none") {
      if (!seen.has("off")) {
        items.push({ value: "off", label: "关闭" });
        seen.add("off");
      }
      continue;
    }
    if (seen.has(normalized)) continue;
    items.push({ value: value as ComposerReasoningValue, label: reasoningLabel(value) });
    seen.add(normalized);
  }
  return items;
}

/** 待发送附件的本地预览地址（图片缩略图），key 为工作区路径 */
export type AttachmentPreviews = Record<string, string>;

/** 上传中的文件；progress 为 0–1 */
export type PendingUpload = {
  id: string;
  name: string;
  size: number;
  progress: number;
};

function AttachmentChip({
  attachment,
  preview,
  onRemove,
}: {
  attachment: CloudAgentAttachment;
  preview?: string;
  onRemove: () => void;
}) {
  const isImage = attachment.kind === "image" && preview;
  return (
    <span
      title={attachment.path}
      className={cn(
        "animate-pop group/chip relative flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 py-1 pr-1 pl-1",
        "transition-[background-color,border-color] duration-200 ease-fluid hover:border-border hover:bg-muted/70",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background">
        {isImage ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={preview} alt="" className="size-full object-cover" />
        ) : (
          <FileIcon className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-40 truncate text-xs text-foreground">{attachment.name}</span>
        {attachment.size > 0 ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatSize(attachment.size)}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`移除 ${attachment.name}`}
        className="rounded-full p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** 上传中的片：进度以底色从左往右填过去，可中途取消 */
function UploadingChip({
  upload,
  onCancel,
}: {
  upload: PendingUpload;
  onCancel: () => void;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, upload.progress)) * 100);
  return (
    <span
      title={upload.name}
      className="animate-pop relative flex items-center gap-2 overflow-hidden rounded-xl border border-dashed border-border/60 bg-muted/20 py-1 pr-1 pl-1"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-muted/70 transition-[width] duration-200 ease-fluid"
        style={{ width: `${percent}%` }}
      />
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-background">
        <Upload className="size-3.5 text-muted-foreground" />
      </span>
      <span className="relative flex min-w-0 flex-col leading-tight">
        <span className="max-w-40 truncate text-xs text-foreground">{upload.name}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {percent}% · {formatSize(upload.size)}
        </span>
      </span>
      <button
        type="button"
        aria-label={`取消上传 ${upload.name}`}
        className="relative rounded-full p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        onClick={onCancel}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

export function Composer({
  value,
  onValueChange,
  onSend,
  onStop,
  textareaRef,
  routeReady,
  sending,
  runActive,
  attachments,
  attachmentPreviews,
  uploads,
  canAttach,
  attachHint,
  onAttachFiles,
  onRemoveAttachment,
  onCancelUpload,
  models,
  model,
  onModelChange,
  reasoning,
  reasoningItems,
  onReasoningChange,
  contextWindow,
  contextWindowOpen,
  compactingContext,
  onContextWindowOpenChange,
  onCompactContext,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 是否已配置 chat 模型路由 */
  routeReady: boolean;
  sending: boolean;
  runActive: boolean;
  attachments: CloudAgentAttachment[];
  attachmentPreviews: AttachmentPreviews;
  uploads: PendingUpload[];
  canAttach: boolean;
  attachHint: string;
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onCancelUpload: (id: string) => void;
  models: ComposerModelItem[];
  model: string;
  onModelChange: (value: string | null) => void;
  reasoning: ComposerReasoningValue;
  reasoningItems: Array<{ value: ComposerReasoningValue; label: string }>;
  onReasoningChange: (value: ComposerReasoningValue) => void;
  contextWindow: ContextWindowInfo;
  contextWindowOpen: boolean;
  compactingContext: boolean;
  onContextWindowOpenChange: (open: boolean) => void;
  onCompactContext: () => void;
  className?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 输入法组字期间的回车属于「选词」，不能当发送 */
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const uploading = uploads.length > 0;
  const canSend =
    routeReady && !sending && !uploading && (value.trim().length > 0 || attachments.length > 0);

  /**
   * 自动高度。不依赖 CSS `field-sizing: content`（Firefox / Safari 尚未支持），
   * 统一用测量法，超过上限转内部滚动。
   */
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [textareaRef]);

  useLayoutEffect(() => {
    resize();
  }, [value, attachments.length, resize]);

  // 容器宽度变化（收展侧栏、旋屏）会改变换行，需要重新测量。
  // 只在宽度真的变了时才重算：容器高度本就随输入框变化，否则会自己触发自己。
  useEffect(() => {
    const parent = textareaRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    let lastWidth = parent.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? lastWidth;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      resize();
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [resize, textareaRef]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    if (e.key !== "Enter") return;
    // 中日韩输入法组字中：回车用于确认候选词，不能触发发送
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.altKey) return; // 换行
    e.preventDefault();
    if (runActive) return;
    if (canSend) onSend();
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    // 即使当前不能上传也要拦下来，交给上层给出「未开启电脑环境」的提示
    e.preventDefault();
    onAttachFiles(files);
  }

  function hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!dragging) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e)) return;
    // 不拦截的话浏览器会直接打开被拖入的文件，当前页面连同草稿一起丢失
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAttachFiles(files);
  }

  const showAttachmentRow = attachments.length > 0 || uploading;

  return (
    <div className={cn("mx-auto w-full max-w-3xl", className)}>
      <div
        onDragEnter={handleDragEnter}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-3xl border bg-background",
          "transition-[border-color,box-shadow] duration-300 ease-fluid",
          focused
            ? "border-ring/45 shadow-[var(--shadow-soft)]"
            : "border-border/70 shadow-sm hover:border-border",
          dragging && "animate-drop-glow border-ring",
        )}
      >
        {/* 拖放覆盖层 */}
        {dragging && (
          <div className="animate-pop absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-3xl border border-dashed border-ring/60 bg-background/85 text-sm text-foreground backdrop-blur-sm">
            <Upload className="size-4" />
            {canAttach ? "松开即可上传到工作区" : "该 Agent 未开启电脑环境"}
          </div>
        )}

        {/* 待发送附件 */}
        <div className="disclosure" data-open={showAttachmentRow ? "" : undefined}>
          <div className="disclosure-inner">
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.path}
                  attachment={a}
                  preview={attachmentPreviews[a.path]}
                  onRemove={() => onRemoveAttachment(a.path)}
                />
              ))}
              {uploads.map((u) => (
                <UploadingChip key={u.id} upload={u} onCancel={() => onCancelUpload(u.id)} />
              ))}
            </div>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          /* 发送中不禁用输入框：禁用会抢走焦点，且用户常要接着敲下一句 */
          disabled={!routeReady}
          placeholder={routeReady ? "发送消息…" : "请先配置 chat 模型路由"}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={cn(
            "block max-h-52 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none",
            "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 md:text-[15px]",
          )}
        />

        {/* 工具行：附件 · 模型 ————— 发送 */}
        <div className="flex items-center gap-0.5 p-2 pl-2.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onAttachFiles(files);
              e.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="添加附件"
                className="size-8 rounded-full text-muted-foreground"
                disabled={!canAttach}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{attachHint}</TooltipContent>
          </Tooltip>

          <ModelPicker
            items={models}
            value={model}
            onValueChange={onModelChange}
            disabled={models.length === 0}
          />

          <Select
            value={reasoning}
            onValueChange={(v) => {
              if (v) onReasoningChange(v as ComposerReasoningValue);
            }}
            items={reasoningItems}
          >
            <SelectTrigger
              aria-label="思考强度"
              className={cn(
                "h-8 rounded-full border-0 px-2 text-[13px] text-muted-foreground shadow-none",
                "transition-[background-color,color] duration-200 ease-fluid hover:bg-muted/70 hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <Brain className="size-3.5 opacity-60" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" align="start" sideOffset={8}>
                  {reasoningItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          <ContextWindowButton
            info={contextWindow}
            open={contextWindowOpen}
            disabled={!routeReady}
            compacting={compactingContext}
            onOpenChange={onContextWindowOpenChange}
            onCompact={onCompactContext}
          />

          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {/* 发送 / 停止：同一枚按钮里两个图标交叉形变 */}
              <Button
                size="icon"
                variant={runActive ? "secondary" : "default"}
                aria-label={runActive ? "停止生成" : "发送"}
                disabled={runActive ? false : !canSend}
                onClick={() => (runActive ? onStop() : onSend())}
                className="relative size-9 shrink-0 rounded-full"
              >
                {runActive && (
                  <svg
                    viewBox="0 0 36 36"
                    aria-hidden
                    className="absolute inset-0 size-full animate-spin opacity-45 [animation-duration:1.8s]"
                  >
                    <circle
                      cx="18"
                      cy="18"
                      r="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeDasharray="24 76"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
                <span className="grid size-4 place-items-center">
                  <ArrowUp
                    className={cn(
                      "col-start-1 row-start-1 size-4 transition-[transform,opacity] duration-300 ease-overshoot",
                      runActive ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100",
                    )}
                  />
                  <Square
                    className={cn(
                      "col-start-1 row-start-1 size-3 transition-[transform,opacity] duration-300 ease-overshoot",
                      runActive ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0",
                    )}
                  />
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {runActive
                ? "停止生成"
                : uploading
                  ? "等待附件上传完成"
                  : "发送 · Shift+Enter 换行"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
