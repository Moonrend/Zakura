"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import {
  Bot,
  Brain,
  ChevronRight,
  Eye,
  FilePen,
  FileSearch,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe,
  Info,
  Link2,
  Loader2,
  MessagesSquare,
  Monitor,
  MoveRight,
  Search,
  Terminal,
  Trash2,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineToolCall } from "@/lib/cloud-agent";

function tryParseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pretty(raw?: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatMs(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 展开详情里的代码/输出块 */
function Block({ text, error }: { text: string; error?: boolean }) {
  if (!text) return null;
  return (
    <pre
      className={cn(
        "max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground",
        error && "text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

type Described = {
  icon: LucideIcon;
  /** 一行灰色摘要（不含图标） */
  label: ReactNode;
  /** 展开后的详情；null 表示无详情可展开 */
  detail: ReactNode;
};

/** 子代理/委派运行记录链接：完整对话已落库为独立会话，可跳转查看 */
function ChildSessionLink({ call }: { call: TimelineToolCall }) {
  if (!call.childSessionId) return null;
  const params = new URLSearchParams({ session: call.childSessionId });
  if (call.childAgentId) params.set("agent", call.childAgentId);
  return (
    <a
      href={`/chat?${params.toString()}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[12px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
    >
      <MessagesSquare className="h-3 w-3" />
      查看完整对话记录
    </a>
  );
}

function FilePathButton({
  path,
  onOpenFile,
}: {
  path: string;
  onOpenFile?: (path: string) => void;
}) {
  if (!onOpenFile) return <span className="font-mono">{path}</span>;
  return (
    <button
      type="button"
      className="font-mono underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground/50"
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onOpenFile(path);
      }}
    >
      {path}
    </button>
  );
}

/** 内置工具 → 人类可读摘要与详情；未识别的工具回退为通用展示 */
function describeCall(
  call: TimelineToolCall,
  onOpenFile?: (path: string) => void,
): Described {
  const name = call.name.replace(/^re_/, "");
  const args = tryParseArgs(call.arguments);
  const result = call.resultText ?? "";
  const resultBlock =
    call.status === "done" && result ? <Block text={result} error={call.isError} /> : null;

  const fileVerb = (verb: string, path: string, extra?: ReactNode): Described => ({
    icon:
      verb === "读取"
        ? FileText
        : verb === "删除"
          ? Trash2
          : verb === "查看"
            ? FileSearch
            : FilePen,
    label: (
      <>
        {verb} <FilePathButton path={path} onOpenFile={onOpenFile} />
      </>
    ),
    detail: (
      <>
        {extra}
        {resultBlock}
      </>
    ),
  });

  switch (name) {
    case "fs_read":
      return fileVerb("读取", str(args.path) || "?");
    case "fs_write":
      return fileVerb(
        "写入",
        str(args.path) || "?",
        str(args.content) ? <Block text={truncate(str(args.content), 2000)} /> : null,
      );
    case "fs_edit":
      return fileVerb(
        "编辑",
        str(args.path) || "?",
        <>
          {str(args.old_text) ? (
            <Block text={`- ${truncate(str(args.old_text), 800)}`} />
          ) : null}
          {str(args.new_text) ? (
            <Block text={`+ ${truncate(str(args.new_text), 800)}`} />
          ) : null}
        </>,
      );
    case "fs_stat":
      return fileVerb("查看", str(args.path) || "?");
    case "fs_delete":
      return fileVerb("删除", str(args.path) || "?");
    case "fs_list":
      return {
        icon: FolderOpen,
        label: (
          <>
            浏览目录{" "}
            <span className="font-mono">{str(args.path) || "."}</span>
          </>
        ),
        detail: resultBlock,
      };
    case "fs_mkdir":
      return {
        icon: FolderPlus,
        label: (
          <>
            新建目录 <span className="font-mono">{str(args.path)}</span>
          </>
        ),
        detail: resultBlock,
      };
    case "fs_move":
      return {
        icon: MoveRight,
        label: (
          <>
            移动 <span className="font-mono">{str(args.from)}</span>
            {" → "}
            <FilePathButton path={str(args.to)} onOpenFile={onOpenFile} />
          </>
        ),
        detail: resultBlock,
      };
    case "get_file_url": {
      const path = str(args.path) || "?";
      let fileName = "";
      try {
        const parsed = JSON.parse(result) as { file_name?: string; url?: string };
        if (typeof parsed.file_name === "string") fileName = parsed.file_name;
      } catch {
        /* ignore */
      }
      return {
        icon: Link2,
        label: (
          <>
            生成分享链接{" "}
            <FilePathButton path={path} onOpenFile={onOpenFile} />
            {fileName && fileName !== path.split("/").pop() ? (
              <span className="text-muted-foreground/70"> · {fileName}</span>
            ) : null}
          </>
        ),
        detail: resultBlock,
      };
    }
    case "revoke_file_url":
      return {
        icon: Link2,
        label: <>撤销分享链接</>,
        detail: resultBlock,
      };
    case "list_file_urls":
      return {
        icon: Link2,
        label: <>列出分享链接</>,
        detail: resultBlock,
      };
    case "shell_exec": {
      const cmd = str(args.command);
      return {
        icon: Terminal,
        label: (
          <span className="font-mono">
            $ {truncate(cmd || "(空命令)", 120)}
          </span>
        ),
        detail: (
          <>
            {cmd.length > 120 ? <Block text={cmd} /> : null}
            {resultBlock}
          </>
        ),
      };
    }
    case "browser_action": {
      const action = str(args.action);
      const target = str(args.url) || str(args.selector) || str(args.text) || str(args.ref);
      return {
        icon: Globe,
        label: (
          <>
            浏览器 · {action || "操作"}
            {target ? <span className="font-mono"> {truncate(target, 80)}</span> : null}
          </>
        ),
        detail: resultBlock,
      };
    }
    case "browser_observe":
      return {
        icon: Eye,
        label: <>查看页面 · {str(args.observe) || "snapshot"}</>,
        detail: resultBlock,
      };
    case "computer_screenshot":
      return { icon: Monitor, label: <>桌面截图</>, detail: resultBlock };
    case "computer_click":
      return {
        icon: Monitor,
        label: (
          <>
            桌面点击 ({String(args.x ?? "?")}, {String(args.y ?? "?")})
          </>
        ),
        detail: resultBlock,
      };
    case "computer_type":
      return {
        icon: Monitor,
        label: <>桌面输入 “{truncate(str(args.text), 40)}”</>,
        detail: resultBlock,
      };
    case "computer_key":
      return {
        icon: Monitor,
        label: <>按键 {str(args.key)}</>,
        detail: resultBlock,
      };
    case "computer_scroll":
    case "computer_move":
    case "desktop_info":
      return { icon: Monitor, label: <>桌面操作 · {name}</>, detail: resultBlock };
    case "delegate_to_agent":
      return {
        icon: Users,
        label: (
          <>
            委派 <span className="font-medium">@{str(args.agentSlug)}</span> ·{" "}
            {truncate(str(args.task), 80)}
          </>
        ),
        detail: (
          <>
            {str(args.task).length > 80 ? <Block text={str(args.task)} /> : null}
            {resultBlock}
            <ChildSessionLink call={call} />
          </>
        ),
      };
    case "spawn_subagent":
      return {
        icon: Bot,
        label: <>子代理 · {truncate(str(args.task), 90)}</>,
        detail: (
          <>
            {str(args.task).length > 90 ? <Block text={str(args.task)} /> : null}
            {resultBlock}
            <ChildSessionLink call={call} />
          </>
        ),
      };
    case "agent_info":
    case "list_exposers":
    case "list_exposures":
      return { icon: Info, label: <>{name}</>, detail: resultBlock };
  }

  // 记忆工具族
  if (/^(memory_|add_memory|search_memory|list_memories|get_memory|update_memory|delete_memory|pin_memory|link_memories)/.test(name)) {
    const q = str(args.query) || str(args.q) || str(args.content);
    return {
      icon: Brain,
      label: (
        <>
          记忆 · {name.replace(/^memory_/, "").replace(/_memory$|_memories$/, "") || name}
          {q ? <> “{truncate(q, 60)}”</> : null}
        </>
      ),
      detail: resultBlock,
    };
  }

  // 搜索 / 抓取类（web-search、web-fetch 及各家 MCP 同类工具）
  const query = str(args.query) || str(args.q);
  if (query && /search/i.test(name)) {
    return {
      icon: Search,
      label: <>搜索 “{truncate(query, 80)}”</>,
      detail: resultBlock,
    };
  }
  const url = str(args.url);
  if (url && /fetch|crawl|scrape|read/i.test(name)) {
    return {
      icon: Link2,
      label: (
        <>
          抓取 <span className="font-mono">{truncate(url, 90)}</span>
        </>
      ),
      detail: resultBlock,
    };
  }

  // 通用回退：工具名 + 参数/结果
  const argsText = call.arguments && call.arguments !== "{}" ? pretty(call.arguments) : "";
  return {
    icon: Wrench,
    label: <span className="font-mono">{name}</span>,
    detail:
      argsText || resultBlock ? (
        <>
          {argsText ? <Block text={truncate(argsText, 2000)} /> : null}
          {resultBlock}
        </>
      ) : null,
  };
}

function ToolRow({
  call,
  onOpenFile,
}: {
  call: TimelineToolCall;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = call.status === "running";
  const { icon: Icon, label, detail } = describeCall(call, onOpenFile);
  const expandable = detail != null && !running;

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 py-[3px] text-left text-[13px] text-muted-foreground/80 transition-colors",
          expandable && "hover:text-foreground",
          call.isError && "text-destructive/80 hover:text-destructive",
        )}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {call.isError && <span className="shrink-0 text-[11px]">失败</span>}
        {call.durationMs != null && call.durationMs > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {formatMs(call.durationMs)}
          </span>
        )}
        {expandable && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && detail && (
        <div className="mb-1 ml-[7px] space-y-1.5 border-l border-border/50 py-0.5 pl-4">
          {detail}
        </div>
      )}
    </div>
  );
}

/**
 * 工具活动：Vercel 式灰色文本行，无卡片边框。
 * 每个调用一行可展开详情；内置工具显示人类可读内容而非 JSON；
 * 文件类操作的路径可点击（联动文件面板）。
 */
export function ToolActivity({
  calls,
  onOpenFile,
}: {
  calls: TimelineToolCall[];
  onOpenFile?: (path: string) => void;
}) {
  if (calls.length === 0) return null;
  return (
    <div className="max-w-[92%] py-0.5">
      {calls.map((c, i) => (
        <ToolRow key={`${c.toolCallId}-${i}`} call={c} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}
