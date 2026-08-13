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
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, Brain, File as FileIcon, Play, Square, Upload, X } from "lucide-react";
import type { ComposerSkillOption, ComposerToolGroup } from "@zakura/shared";

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
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import { ContextWindowButton, type ContextWindowInfo } from "./context-window";
import { ComposerPlusMenu, SkillRequestChip } from "./composer-plus-menu";

/** 约 8 行后转为内部滚动 */
const MAX_TEXTAREA_HEIGHT = 208;

/** 粘贴文本超过此阈值时改为附件，避免把大段内容塞进输入框 */
const PASTE_AS_FILE_CHARS = 2000;
const PASTE_AS_FILE_LINES = 40;

function shouldPasteAsFile(text: string): boolean {
  if (text.length >= PASTE_AS_FILE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > PASTE_AS_FILE_LINES) return true;
    }
  }
  return false;
}

function pasteTextFile(text: string): File {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return new File([text], `paste-${stamp}.txt`, { type: "text/plain" });
}

export type ComposerModelItem = ModelRouteSelectorItem;

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
  sending: _sending,
  runActive,
  /** 运行中发送按钮的提示（注入 / 排队） */
  runSendHint,
  attachments,
  attachmentPreviews,
  uploads,
  canAttach,
  attachHint,
  onAttachFiles,
  onRemoveAttachment,
  onCancelUpload,
  skills,
  selectedSkills,
  onToggleSkill,
  toolGroups,
  disabledGroupIds,
  onToggleGroup,
  models,
  model,
  modelRouteId,
  onModelSelection,
  reasoning,
  reasoningItems,
  onReasoningChange,
  contextWindow,
  contextWindowOpen,
  compactingContext,
  onContextWindowOpenChange,
  onCompactContext,
  queueSlot,
  canRecallQueued,
  onRecallQueued,
  editing,
  onCancelEdit,
  showContinue,
  onContinue,
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
  /** 运行中且有内容时，发送按钮的 tooltip */
  runSendHint?: string;
  attachments: CloudAgentAttachment[];
  attachmentPreviews: AttachmentPreviews;
  uploads: PendingUpload[];
  canAttach: boolean;
  attachHint: string;
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onCancelUpload: (id: string) => void;
  skills: ComposerSkillOption[];
  selectedSkills: string[];
  onToggleSkill: (name: string) => void;
  toolGroups: ComposerToolGroup[];
  disabledGroupIds: string[];
  onToggleGroup: (id: string) => void;
  models: ComposerModelItem[];
  model: string;
  modelRouteId?: string | null;
  onModelSelection: (value: string | null, routeId: string | null) => void;
  reasoning: ComposerReasoningValue;
  reasoningItems: Array<{ value: ComposerReasoningValue; label: string }>;
  onReasoningChange: (value: ComposerReasoningValue) => void;
  contextWindow: ContextWindowInfo;
  contextWindowOpen: boolean;
  compactingContext: boolean;
  onContextWindowOpenChange: (open: boolean) => void;
  onCompactContext: () => void;
  /** 贴在输入卡片上方的排队列表 */
  queueSlot?: ReactNode;
  /** 输入框为空时按 ↑ 可把最近排队的消息召回编辑（Codex edit_queued_message） */
  canRecallQueued?: boolean;
  onRecallQueued?: () => void;
  /** 编辑已发送消息：内容在 Composer 里改，发送后成兄弟分支 */
  editing?: boolean;
  onCancelEdit?: () => void;
  /** 上次 Run 中途停止：在输入卡片左上角显示「继续」chip */
  showContinue?: boolean;
  onContinue?: () => void;
  className?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 输入法组字期间的回车属于「选词」，不能当发送 */
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const uploading = uploads.length > 0;
  // 不因 sending 禁用：首条 POST 进行中也可把下一句入队
  const canSend =
    routeReady && !uploading && (value.trim().length > 0 || attachments.length > 0);

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

  /** 运行中有内容时改为「入队」；无内容时仍是停止 */
  const showStop = runActive && !canSend;

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      if (editing) {
        e.preventDefault();
        onCancelEdit?.();
        return;
      }
      e.currentTarget.blur();
      return;
    }
    // 中日韩输入法组字中：按键（候选导航/回车选词）都交给输入法
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 空输入框按 ↑：把最近排队的消息召回输入框编辑（不与光标移动冲突）
    if (
      e.key === "ArrowUp" &&
      canRecallQueued &&
      !editing &&
      value === "" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      onRecallQueued?.();
      return;
    }
    if (e.key !== "Enter") return;
    // Ctrl/⌘+Enter：始终发送（与换行、系统快捷键不冲突）
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (canSend) onSend();
      return;
    }
    if (e.shiftKey || e.altKey) return; // 换行
    e.preventDefault();
    // 运行中也可发送：服务端入队，当前回合结束后按序发出
    if (canSend) onSend();
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      // 即使当前不能上传也要拦下来，交给上层给出「未开启电脑环境」的提示
      e.preventDefault();
      onAttachFiles(files);
      return;
    }
    if (!canAttach) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!shouldPasteAsFile(text)) return;
    e.preventDefault();
    onAttachFiles([pasteTextFile(text)]);
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

  const showAttachmentRow = attachments.length > 0 || uploading || selectedSkills.length > 0;

  return (
    <div className={cn("mx-auto w-full max-w-3xl", className)}>
      <div className="flex flex-col">
        {/* 排队区：输入卡片上方 */}
        {queueSlot}

        <div className="relative">
        {showContinue && !editing ? (
          <button
            type="button"
            disabled={!routeReady}
            onClick={() => onContinue?.()}
            className="animate-pop absolute top-0 left-0 z-20 inline-flex h-7 -translate-y-[calc(100%+0.375rem)] items-center gap-1 rounded-full border border-border/70 bg-background/90 px-2.5 text-xs text-foreground/80 shadow-[var(--shadow-soft)] backdrop-blur transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Play className="size-3 fill-current" />
            继续
          </button>
        ) : null}

        <div
          onDragEnter={handleDragEnter}
          onDragOver={(e) => {
            if (hasFiles(e)) e.preventDefault();
          }}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "relative z-10 rounded-xl border bg-background",
            "transition-[border-color,box-shadow] duration-200 ease-out-soft",
            focused || editing
              ? "border-ring/45 shadow-[var(--shadow-soft)]"
              : "border-border/70 shadow-sm hover:border-border",
            dragging && "border-dashed border-ring",
          )}
        >
        {/* 拖放覆盖层 */}
        {dragging && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-xl border border-dashed border-ring/60 bg-background/95 text-sm text-foreground">
            <Upload className="size-4" />
            {canAttach ? "松开即可上传到工作区" : "该 Agent 未开启电脑环境"}
          </div>
        )}

        {editing ? (
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              编辑消息 · 发送后成为新分支
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onCancelEdit?.()}
            >
              取消
              <kbd className="ml-1.5 rounded border border-border/70 bg-muted/50 px-1 font-sans text-[10px] text-muted-foreground/80">
                Esc
              </kbd>
            </Button>
          </div>
        ) : null}

        {/* 待发送附件 */}
        <div className="disclosure" data-open={showAttachmentRow ? "" : undefined}>
          <div className="disclosure-inner">
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {selectedSkills.map((name) => {
                const skill = skills.find((s) => s.name === name);
                return (
                  <SkillRequestChip
                    key={name}
                    name={name}
                    title={skill?.title}
                    onRemove={() => onToggleSkill(name)}
                  />
                );
              })}
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
          placeholder={
            !routeReady
              ? "请先配置 chat 模型路由"
              : editing
                ? "编辑消息…"
                : runActive
                  ? "发送后续…"
                  : "发送消息…"
          }
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

        {/* 工具行：添加 · 模型 ————— 发送 */}
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
          <ComposerPlusMenu
            canAttach={canAttach}
            attachHint={attachHint}
            onUpload={() => fileInputRef.current?.click()}
            skills={skills}
            selectedSkills={selectedSkills}
            onToggleSkill={onToggleSkill}
            groups={toolGroups}
            disabledGroupIds={disabledGroupIds}
            onToggleGroup={onToggleGroup}
          />

          <ModelRouteSelector
            items={models}
            value={model}
            routeId={modelRouteId}
            onSelectionChange={onModelSelection}
            disabled={models.length === 0}
            side="top"
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
              {/* 发送 / 入队 / 停止：有内容时优先发送（运行中=入队），空内容且运行中才是停止 */}
              <Button
                size="icon"
                variant={showStop ? "secondary" : "default"}
                aria-label={
                  showStop ? "停止生成" : editing ? "发送编辑" : runActive ? "加入队列" : "发送"
                }
                disabled={showStop ? false : !canSend}
                onClick={() => (showStop ? onStop() : onSend())}
                className="relative size-9 shrink-0 rounded-full"
              >
                {showStop && (
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
                      showStop ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100",
                    )}
                  />
                  <Square
                    className={cn(
                      "col-start-1 row-start-1 size-3 transition-[transform,opacity] duration-300 ease-overshoot",
                      showStop ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0",
                    )}
                  />
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showStop
                ? "停止生成"
                : uploading
                  ? "等待附件上传完成"
                  : editing
                    ? "发送编辑 · Esc 取消"
                    : runActive
                      ? (runSendHint ?? "发送到当前回合")
                      : "发送 · Shift+Enter 换行"}
            </TooltipContent>
          </Tooltip>
        </div>
        </div>
        </div>
      </div>
    </div>
  );
}
