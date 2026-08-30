"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChatMarkdown } from "@/components/markdown/chat-markdown";

import {
  Bot,
  Brain,
  ChevronRight,
  Eye,
  Layers,
  File as FileIcon,
  FilePen,
  FileSearch,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Info,
  Link2,
  MessagesSquare,
  Monitor,
  MoveRight,
  Pin,
  Search,
  SquareArrowOutUpRight,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import { Disclosure } from "@/components/ui/disclosure";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/agent-fs";
import type { TimelineToolCall } from "@/lib/cloud-agent";
import { foldPtyText, isSilentAgentTool } from "@zakura/shared";

/** 思考 / 工具 / 上下文压缩共用一条活动时间轴 */
export type ActivityStep =
  | { kind: "tool"; call: TimelineToolCall }
  | {
      kind: "reasoning";
      id: string;
      content: string;
      active: boolean;
    }
  | {
      kind: "compaction";
      id: string;
      active: boolean;
      summary: string;
      beforeChars: number;
      afterChars: number;
      droppedMessages: number;
      keptMessages: number;
      source: string;
      durationMs?: number;
      model?: string;
      phase?: "start" | "summarizing";
      progress?: number;
      failed?: boolean;
    };
import {
  hostOf,
  isBareAck,
  isFetchTool,
  isSearchTool,
  languageFromPath,
  parseFsList,
  parseFsRead,
  parseFsStat,
  parseMarkdownDocs,
  parseMemoryItems,
  parseShellResult,
  parseWebSources,
  parseWrittenBytes,
  type FsListResult,
  type MarkdownDoc,
  type MemoryItem,
} from "@/lib/tool-result";
import { Favicon, FaviconStack, WebSourceChips } from "./web-sources";

/** 超过这个步数就把中间步骤折起来，避免长工具链淹没回答 */
const COLLAPSE_THRESHOLD = 7;
const HEAD_ROWS = 3;
const TAIL_ROWS = 2;

/** 展开区最大宽度：跟正文一样有度量感，不会被一张宽表格撑满整屏 */
const DETAIL_WIDTH = "w-[min(42rem,100%)]";

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

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 拼接工作区路径：fs_list 的条目名是相对目录的 */
function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  return base ? `${base}/${name}` : `/${name}`;
}

/**
 * 运行中的计时。事件流里没有开始时间戳，所以以「本行首次以 running 渲染」为起点，
 * 结束后由服务端的 durationMs 接管显示。
 */
function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    setMs(0);
    const id = window.setInterval(() => setMs(performance.now() - start), 100);
    return () => window.clearInterval(id);
  }, [active]);
  return ms;
}

/** 展开详情里的代码/输出块 */
function Block({
  text,
  tone,
  label,
  follow,
}: {
  text: string;
  tone?: "error" | "add" | "remove";
  label?: string;
  follow?: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!follow || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [follow, text]);
  if (!text) return null;
  return (
    <div className="min-w-0">
      {label ? (
        <div className="pb-1 text-[11px] text-muted-foreground">{label}</div>
      ) : null}
      <pre
        ref={preRef}
        className={cn(
          "max-h-56 overflow-auto rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground",
          tone === "error" && "bg-destructive/5 text-destructive",
          tone === "remove" && "bg-destructive/5 text-destructive/85",
          tone === "add" && "bg-foreground/5 text-foreground/85",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

/** 一行浅色的元信息（行数、字节数、是否截断…） */
function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground/70">
      {children}
    </div>
  );
}

/**
 * 抓取回来的正文：Firecrawl / Jina Reader 这类工具返回的是整篇 Markdown，
 * 按 Markdown 渲染而不是塞进 <pre>，长文才读得下去。
 */
function MarkdownDocBlock({ doc }: { doc: MarkdownDoc }) {
  const domain = doc.url ? hostOf(doc.url) : "";
  const heading = doc.title || domain;
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/15">
      {heading ? (
        <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5">
          {domain ? (
            <Favicon domain={domain} className="size-4 shrink-0" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {heading}
          </span>
          {doc.url ? (
            <a
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e: MouseEvent) => e.stopPropagation()}
              className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
              aria-label="打开原网页"
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}
      <div className="max-h-[26rem] overflow-auto px-3 py-2">
        <ChatMarkdown content={doc.markdown} final fade={false} variant="compact" />
      </div>
    </div>
  );
}

/** fs_list 的目录清单：目录在前，文件可点开 */
function FileListBlock({
  result,
  onOpenFile,
}: {
  result: FsListResult;
  onOpenFile?: (path: string) => void;
}) {
  const sorted = useMemo(
    () =>
      [...result.entries].sort((a, b) => {
        if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [result.entries],
  );
  if (sorted.length === 0) {
    return <Meta>空目录</Meta>;
  }
  const shown = sorted.slice(0, 80);
  const rest = sorted.length - shown.length;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {shown.map((e) => {
          const full = joinPath(result.path, e.name);
          const inner = (
            <>
              {e.type === "dir" ? (
                <Folder className="size-3 shrink-0 text-muted-foreground/60" />
              ) : (
                <FileIcon className="size-3 shrink-0 text-muted-foreground/50" />
              )}
              <span className="truncate">{e.name}</span>
            </>
          );
          const base =
            "inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-1.5 py-[3px] font-mono text-[11px] text-muted-foreground";
          if (e.type === "dir" || !onOpenFile) {
            return (
              <span key={e.name} title={full} className={base}>
                {inner}
              </span>
            );
          }
          return (
            <button
              key={e.name}
              type="button"
              title={`${full}${e.size != null ? ` · ${formatSize(e.size)}` : ""}`}
              onClick={(ev: MouseEvent) => {
                ev.stopPropagation();
                onOpenFile(full);
              }}
              className={cn(
                base,
                "transition-[background-color,border-color,color] duration-150 ease-fluid hover:border-border hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {inner}
            </button>
          );
        })}
      </div>
      {(rest > 0 || result.truncated) && (
        <Meta>{rest > 0 ? `另有 ${rest} 项` : "结果已截断"}</Meta>
      )}
    </div>
  );
}

/** 记忆条目：正文 + 分层 / 标签，按检索顺序错峰进场 */
function MemoryCards({ items }: { items: MemoryItem[] }) {
  return (
    <div className="stagger-rows space-y-1">
      {items.map((m, i) => (
        <div
          key={m.id ?? i}
          className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5"
        >
          <div className="line-clamp-4 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
            {m.content}
          </div>
          {m.layer || m.tags.length > 0 || m.pinned ? (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground/70">
              {m.pinned ? <Pin className="size-2.5" /> : null}
              {m.layer ? (
                <span className="rounded bg-muted px-1 py-px font-mono">{m.layer}</span>
              ) : null}
              {m.tags.slice(0, 6).map((t) => (
                <span key={t} className="rounded bg-muted px-1 py-px">
                  #{t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

type Described = {
  icon: LucideIcon;
  /** 一行摘要（不含图标） */
  label: ReactNode;
  /** 运行中替换摘要的动词，例如「正在搜索…」 */
  runningLabel?: string;
  /** 行尾的紧凑指示物（站点图标堆、退出码徽标等） */
  trailing?: ReactNode;
  /** 展开后的详情；null 表示无详情可展开 */
  detail: ReactNode;
};

/**
 * 拼接详情片段：全为空时返回 null。
 * 直接写 `<>{a}{b}</>` 的话，即便 a、b 都是 null，片段本身仍然非空，
 * 那一行就会带上箭头、点开却是个空盒子。
 */
function detailOf(...parts: ReactNode[]): ReactNode {
  if (!parts.some((p) => p != null && p !== false && p !== "")) return null;
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

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
      className="inline-flex items-center gap-1 text-[12px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/40"
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
    <span
      role="link"
      tabIndex={0}
      className="font-mono underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/50"
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onOpenFile(path);
      }}
      onKeyDown={(e: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onOpenFile(path);
      }}
    >
      {path}
    </span>
  );
}

/** shell 退出码徽标：0 静默，非 0 才醒目 */
function ExitBadge({ code }: { code: number }) {
  return (
    <span
      className={cn(
        "animate-pop shrink-0 rounded-md px-1.5 py-px font-mono text-[10px] tabular-nums",
        code === 0
          ? "bg-muted text-muted-foreground/80"
          : "bg-destructive/10 text-destructive",
      )}
    >
      exit {code}
    </span>
  );
}

/** 内置工具 → 人类可读摘要与详情；未识别的工具回退为通用展示 */
function describeCall(
  call: TimelineToolCall,
  onOpenFile?: (path: string) => void,
): Described {
  const inner = describeCallBody(call, onOpenFile);
  if (!call.diffs?.length) return inner;
  return {
    ...inner,
    detail: detailOf(
      ...call.diffs.map((d) => (
        <div key={d.path} className="space-y-1.5">
          <Meta>
            <FilePathButton path={d.path} onOpenFile={onOpenFile} />
          </Meta>
          {d.oldText ? (
            <Block text={truncate(d.oldText, 4000)} tone="remove" label="替换前" />
          ) : null}
          <Block text={truncate(d.newText, 4000)} tone="add" label="替换后" />
        </div>
      )),
      inner.detail,
    ),
  };
}

function describeCallBody(
  call: TimelineToolCall,
  onOpenFile?: (path: string) => void,
): Described {
  const name = call.name.replace(/^re_/, "");
  const args = tryParseArgs(call.arguments);
  const result = call.resultText ?? "";
  const done = call.status === "done";
  const ok = done && !call.isError;
  /** 结果解析不出结构时的兜底文本块；只有 ok 的确认信息不值得展开 */
  const resultBlock =
    done && result && !(ok && isBareAck(result)) ? (
      <Block text={result} tone={call.isError ? "error" : undefined} />
    ) : null;

  const fileVerb = (
    verb: string,
    path: string,
    ...extra: ReactNode[]
  ): Described => ({
    icon:
      verb === "读取"
        ? FileText
        : verb === "删除"
          ? Trash2
          : verb === "查看"
            ? FileSearch
            : FilePen,
    runningLabel: `${verb}文件…`,
    label: (
      <>
        {verb} <FilePathButton path={path} onOpenFile={onOpenFile} />
      </>
    ),
    detail: detailOf(...extra, resultBlock),
  });

  switch (name) {
    case "fs_read": {
      const path = str(args.path) || "?";
      const read = ok ? parseFsRead(result) : null;
      if (!read) return fileVerb("读取", path);
      const lang = languageFromPath(read.path || path);
      const lines = read.content ? read.content.split("\n").length : 0;
      return {
        icon: FileText,
        runningLabel: "读取文件…",
        label: (
          <>
            读取 <FilePathButton path={read.path || path} onOpenFile={onOpenFile} />
          </>
        ),
        trailing: read.totalLines ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {read.totalLines} 行
          </span>
        ) : undefined,
        detail: detailOf(
          <Block text={truncate(read.content, 20_000)} label={lang || undefined} />,
          read.truncated ? (
            <Meta>已截断，仅显示 {lines} / {read.totalLines ?? "?"} 行</Meta>
          ) : null,
        ),
      };
    }
    case "fs_write": {
      const bytes = ok ? parseWrittenBytes(result) : null;
      return {
        ...fileVerb(
          "写入",
          str(args.path) || "?",
          str(args.content) ? (
            <Block text={truncate(str(args.content), 20_000)} label="写入内容" />
          ) : null,
          bytes != null ? <Meta>已写入 {formatSize(bytes)}</Meta> : null,
        ),
        trailing:
          bytes != null ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
              {formatSize(bytes)}
            </span>
          ) : undefined,
      };
    }
    case "fs_edit":
      return fileVerb(
        "编辑",
        str(args.path) || "?",
        str(args.old_text) ? (
          <Block text={truncate(str(args.old_text), 4000)} tone="remove" label="替换前" />
        ) : null,
        str(args.new_text) ? (
          <Block text={truncate(str(args.new_text), 4000)} tone="add" label="替换后" />
        ) : null,
      );
    case "fs_stat": {
      const stat = ok ? parseFsStat(result) : null;
      return {
        ...fileVerb(
          "查看",
          str(args.path) || "?",
          stat ? (
            <Meta>
              <span>{stat.type === "dir" ? "目录" : "文件"}</span>
              <span>·</span>
              <span className="tabular-nums">{formatSize(stat.size)}</span>
              <span>·</span>
              <span className="tabular-nums">
                {new Date(stat.mtime).toLocaleString("zh-CN")}
              </span>
            </Meta>
          ) : null,
        ),
        trailing: stat ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {stat.type === "dir" ? "目录" : formatSize(stat.size)}
          </span>
        ) : undefined,
      };
    }
    case "fs_delete":
      return fileVerb("删除", str(args.path) || "?");
    case "fs_list": {
      const list = ok ? parseFsList(result) : null;
      return {
        icon: FolderOpen,
        runningLabel: "读取目录…",
        label: (
          <>
            浏览目录 <span className="font-mono">{str(args.path) || "."}</span>
          </>
        ),
        trailing: list ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {list.entries.length} 项
          </span>
        ) : undefined,
        detail: list ? (
          <FileListBlock result={list} onOpenFile={onOpenFile} />
        ) : (
          detailOf(resultBlock)
        ),
      };
    }
    case "fs_mkdir":
      return {
        icon: FolderPlus,
        label: (
          <>
            新建目录 <span className="font-mono">{str(args.path)}</span>
          </>
        ),
        detail: detailOf(resultBlock),
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
        detail: detailOf(resultBlock),
      };
    case "get_file_url": {
      const path = str(args.path) || "?";
      let fileName = "";
      try {
        const parsed = JSON.parse(result) as { file_name?: string };
        if (typeof parsed.file_name === "string") fileName = parsed.file_name;
      } catch {
        /* ignore */
      }
      return {
        icon: Link2,
        label: (
          <>
            生成分享链接 <FilePathButton path={path} onOpenFile={onOpenFile} />
            {fileName && fileName !== path.split("/").pop() ? (
              <span className="text-muted-foreground/70"> · {fileName}</span>
            ) : null}
          </>
        ),
        detail: detailOf(resultBlock),
      };
    }
    case "revoke_file_url":
      return { icon: Link2, label: <>撤销分享链接</>, detail: detailOf(resultBlock) };
    case "list_file_urls":
      return { icon: Link2, label: <>列出分享链接</>, detail: detailOf(resultBlock) };
    case "shell_exec": {
      const cmd = str(args.command);
      const jobArg = str(args.job_id);
      const shell = done ? parseShellResult(result) : null;
      const cmdBlock = cmd.length > 120 ? <Block text={cmd} label="命令" /> : null;
      const liveOut = !done ? foldPtyText(call.liveStdout ?? "") : "";
      const liveErr = !done ? foldPtyText(call.liveStderr ?? "") : "";
      const stillRunning = shell?.status === "running";
      return {
        icon: Terminal,
        runningLabel: jobArg && !cmd ? "等待命令输出…" : "执行命令…",
        label: (
          <span className="font-mono">
            $ {truncate(cmd || (jobArg ? `job ${jobArg}` : "(空命令)"), 120)}
          </span>
        ),
        trailing: stillRunning ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/60">仍在运行</span>
        ) : shell && shell.exitCode != null ? (
          <ExitBadge code={shell.exitCode} />
        ) : undefined,
        detail: shell
          ? detailOf(
              cmdBlock,
              shell.stdout ? (
                <Block
                  text={shell.stdout}
                  label={shell.stderr ? "stdout" : undefined}
                />
              ) : null,
              shell.stderr ? <Block text={shell.stderr} tone="error" label="stderr" /> : null,
              !shell.stdout && !shell.stderr ? <Meta>无输出</Meta> : null,
              stillRunning && shell.jobId ? <Meta>job {shell.jobId}</Meta> : null,
            )
          : detailOf(
              cmdBlock,
              liveOut ? <Block text={liveOut} follow /> : null,
              liveErr ? <Block text={liveErr} tone="error" label="stderr" follow /> : null,
            ),
      };
    }
    case "browser_action": {
      const action = str(args.action);
      const target = str(args.url) || str(args.selector) || str(args.text) || str(args.ref);
      const url = str(args.url);
      const domain = hostOf(url);
      return {
        icon: Globe,
        runningLabel: "操作浏览器…",
        label: (
          <>
            浏览器 · {action || "操作"}
            {target ? <span className="font-mono"> {truncate(target, 80)}</span> : null}
          </>
        ),
        trailing: domain ? (
          <FaviconStack sources={[{ url, domain, title: "" }]} />
        ) : undefined,
        detail: detailOf(
          domain ? <WebSourceChips sources={[{ url, domain, title: domain }]} /> : null,
          resultBlock,
        ),
      };
    }
    case "browser_observe":
      return {
        icon: Eye,
        runningLabel: "读取页面…",
        label: <>查看页面 · {str(args.observe) || "snapshot"}</>,
        detail: detailOf(resultBlock),
      };
    case "computer_screenshot":
      return { icon: Monitor, label: <>桌面截图</>, detail: detailOf(resultBlock) };
    case "computer_click":
      return {
        icon: Monitor,
        label: (
          <>
            桌面点击 ({String(args.x ?? "?")}, {String(args.y ?? "?")})
          </>
        ),
        detail: detailOf(resultBlock),
      };
    case "computer_type":
      return {
        icon: Monitor,
        label: <>桌面输入 “{truncate(str(args.text), 40)}”</>,
        detail: detailOf(resultBlock),
      };
    case "computer_key":
      return { icon: Monitor, label: <>按键 {str(args.key)}</>, detail: detailOf(resultBlock) };
    case "computer_scroll":
    case "computer_move":
    case "desktop_info":
      return { icon: Monitor, label: <>桌面操作 · {name}</>, detail: detailOf(resultBlock) };
    case "delegate_to_agent":
      return {
        icon: Users,
        runningLabel: `委派给 @${str(args.agentSlug) || "agent"}…`,
        label: (
          <>
            委派 <span className="font-medium">@{str(args.agentSlug)}</span> ·{" "}
            {truncate(str(args.task), 80)}
          </>
        ),
        detail: detailOf(
          str(args.task).length > 80 ? <Block text={str(args.task)} label="任务" /> : null,
          resultBlock,
          call.childSessionId ? <ChildSessionLink call={call} /> : null,
        ),
      };
    case "spawn_subagent":
      return {
        icon: Bot,
        runningLabel: "子代理执行中…",
        label: <>子代理 · {truncate(str(args.task), 90)}</>,
        detail: detailOf(
          str(args.task).length > 90 ? <Block text={str(args.task)} label="任务" /> : null,
          resultBlock,
          call.childSessionId ? <ChildSessionLink call={call} /> : null,
        ),
      };
    case "agent_info":
    case "list_exposers":
    case "list_exposures":
      return { icon: Info, label: <>{name}</>, detail: detailOf(resultBlock) };
  }

  // 记忆工具族
  if (
    /^(memory_|add_memory|search_memory|list_memories|get_memory|update_memory|delete_memory|pin_memory|link_memories)/.test(
      name,
    )
  ) {
    const q = str(args.query) || str(args.q) || str(args.content);
    const items = ok ? parseMemoryItems(result) : [];
    return {
      icon: Brain,
      runningLabel: "检索记忆…",
      label: (
        <>
          记忆 · {name.replace(/^memory_/, "").replace(/_memory$|_memories$/, "") || name}
          {q ? <> “{truncate(q, 60)}”</> : null}
        </>
      ),
      trailing:
        items.length > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {items.length} 条
          </span>
        ) : undefined,
      detail:
        items.length > 0 ? <MemoryCards items={items} /> : detailOf(resultBlock),
    };
  }

  // 搜索族：把返回值解析成网页来源，行尾显示站点图标堆，展开是来源 chip
  const query = str(args.query) || str(args.q) || str(args.keyword) || str(args.search);
  if (query && isSearchTool(name)) {
    const sources = ok ? parseWebSources(result) : [];
    return {
      icon: Search,
      runningLabel: `搜索 “${truncate(query, 40)}”…`,
      label: <>搜索 “{truncate(query, 80)}”</>,
      trailing: sources.length > 0 ? <FaviconStack sources={sources} /> : undefined,
      detail:
        sources.length > 0
          ? detailOf(<Meta>{sources.length} 个来源</Meta>, <WebSourceChips sources={sources} />)
          : detailOf(resultBlock),
    };
  }

  // 抓取网页族：优先把正文按 Markdown 渲染（Firecrawl / Jina Reader 等）
  const url = str(args.url) || str(args.uri) || str(args.link);
  if (isFetchTool(name)) {
    const domain = hostOf(url);
    const docs = ok ? parseMarkdownDocs(result) : [];
    const sources = docs.length === 0 && ok ? parseWebSources(result, 12) : [];
    const stackSources = domain
      ? [{ url, domain, title: "" }]
      : docs
          .map((d) => (d.url ? { url: d.url, domain: hostOf(d.url), title: "" } : null))
          .filter((s): s is { url: string; domain: string; title: string } => Boolean(s?.domain));
    return {
      icon: Link2,
      runningLabel: `抓取 ${domain || "网页"}…`,
      label: (
        <>
          抓取 <span className="font-mono">{truncate(url || name, 90)}</span>
        </>
      ),
      trailing:
        stackSources.length > 0 ? <FaviconStack sources={stackSources} /> : undefined,
      detail: detailOf(
        ...docs.map((d, i) => (
          <MarkdownDocBlock
            key={d.url ?? i}
            doc={{ ...d, url: d.url ?? (url || undefined) }}
          />
        )),
        sources.length > 0 ? <WebSourceChips sources={sources} /> : null,
        docs.length === 0 ? resultBlock : null,
      ),
    };
  }

  // 通用回退：工具名 + 参数/结果
  const displayName = call.title?.trim() || name;
  const argsText = call.arguments && call.arguments !== "{}" ? pretty(call.arguments) : "";
  const genericDocs = ok ? parseMarkdownDocs(result, 1) : [];
  return {
    icon: Wrench,
    runningLabel: `调用 ${displayName}…`,
    label: <span className="font-mono">{displayName}</span>,
    detail: detailOf(
      argsText ? <Block text={truncate(argsText, 4000)} label="参数" /> : null,
      genericDocs.length > 0 ? <MarkdownDocBlock doc={genericDocs[0]!} /> : resultBlock,
    ),
  };
}

/** 状态图标：完成=语义图标, running=spinner, error=叉 */
function StatusIcon({
  running,
  error,
  Icon,
}: {
  running: boolean;
  error?: boolean;
  Icon: LucideIcon;
}) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-background",
        error && "text-destructive",
      )}
    >
      {running ? (
        <span
          className="size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/50 border-t-transparent"
          aria-hidden
        />
      ) : error ? (
        <X className="size-3.5" />
      ) : (
        <Icon className="size-3.5 opacity-60" />
      )}
    </span>
  );
}

function ToolRow({
  call,
  onOpenFile,
  agentId,
  sessionId,
}: {
  call: TimelineToolCall;
  onOpenFile?: (path: string) => void;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  /** 展开过才真正挂载详情：抓回来的整篇正文不该在折叠状态下白渲染一遍 */
  const [mounted, setMounted] = useState(false);
  const [hydrated, setHydrated] = useState<{
    arguments?: string;
    resultText?: string;
  } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const running = call.status === "running";
  const elapsed = useElapsed(running);
  const live = Boolean(call.liveStdout || call.liveStderr);
  const effectiveCall = useMemo<TimelineToolCall>(
    () =>
      hydrated
        ? {
            ...call,
            arguments: hydrated.arguments ?? call.arguments,
            resultText: hydrated.resultText ?? call.resultText,
            detailPending: false,
          }
        : call,
    [call, hydrated],
  );
  // 每条 SSE 事件都会重建 timeline，这里避免对同一份结果反复做 JSON 解析
  const {
    icon: Icon,
    label,
    runningLabel,
    trailing,
    detail,
  } = useMemo(
    () => describeCall(effectiveCall, onOpenFile),
    [
      effectiveCall.name,
      effectiveCall.title,
      effectiveCall.arguments,
      effectiveCall.resultText,
      effectiveCall.status,
      effectiveCall.isError,
      effectiveCall.durationMs,
      effectiveCall.childSessionId,
      effectiveCall.childAgentId,
      effectiveCall.liveStdout,
      effectiveCall.liveStderr,
      effectiveCall.diffs,
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖上面的具体字段而非对象身份
      onOpenFile,
    ],
  );
  const needsFetch = Boolean(call.detailPending && !hydrated && agentId && sessionId);
  const expandable = detail != null || needsFetch;
  const duration =
    running && elapsed > 400
      ? formatMs(elapsed)
      : call.durationMs != null && call.durationMs > 0
        ? formatMs(call.durationMs)
        : "";

  useEffect(() => {
    if (!running || !live) return;
    setMounted(true);
    setOpen(true);
  }, [running, live]);

  const ensureDetail = async () => {
    if (!needsFetch || loadingDetail) return;
    setLoadingDetail(true);
    try {
      const { getCloudToolDetails } = await import("@/lib/cloud-agent");
      const res = await getCloudToolDetails(agentId!, sessionId!, [call.toolCallId]);
      const row = res.tools[0];
      if (row) {
        setHydrated({
          arguments: row.arguments,
          resultText: row.resultText,
        });
      } else {
        setHydrated({ arguments: call.arguments, resultText: call.resultText });
      }
    } catch {
      setHydrated({ arguments: call.arguments, resultText: call.resultText });
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div className="flex max-w-full min-w-0 flex-col items-start">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          if (!expandable) return;
          setMounted(true);
          setOpen((v) => !v);
          if (!open) void ensureDetail();
        }}
        className={cn(
          "group/row -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[13px] text-muted-foreground/85",
          "transition-colors duration-150 ease-fluid",
          expandable && "hover:text-foreground",
          call.isError && "text-destructive/85 hover:text-destructive",
        )}
      >
        <StatusIcon running={running || loadingDetail} error={call.isError} Icon={Icon} />
        <span
          className={cn("min-w-0 truncate", running && runningLabel && "text-shimmer")}
        >
          {running && runningLabel ? runningLabel : label}
        </span>
        {trailing}
        {call.isError && <span className="shrink-0 text-[11px]">失败</span>}
        {duration && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {duration}
          </span>
        )}
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 transition-transform duration-200 ease-fluid",
            open && "rotate-90",
            !expandable && "hidden",
          )}
        />
      </button>
      {expandable ? (
        <Disclosure open={open} className={cn("max-w-full", DETAIL_WIDTH)}>
          <div className="min-w-0 space-y-1.5 py-1.5 pr-1 pl-[26px]">
            {mounted ? (loadingDetail && !hydrated ? (
              <span className="text-[12px] text-muted-foreground/70">加载详情…</span>
            ) : (
              detail
            )) : null}
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** 中间步骤的折叠条：点开时中段行以流体高度展开 */
function MoreStepsRow({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/more -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[12.5px] text-muted-foreground/70 transition-colors duration-150 hover:text-foreground"
    >
      <span className="relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-background">
        <span className="flex gap-[3px]" aria-hidden>
          <span className="size-[3px] rounded-full bg-current opacity-50" />
          <span className="size-[3px] rounded-full bg-current opacity-50" />
          <span className="size-[3px] rounded-full bg-current opacity-50" />
        </span>
      </span>
      <span className="min-w-0 truncate">
        {open ? "收起中间步骤" : `还有 ${count} 步`}
      </span>
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground/40 transition-transform duration-200 ease-fluid",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

/**
 * 工具/思考活动：一条时间轴上的灰色文本行。
 * 思考与工具算同组步骤；正文开始后 autoCollapse 只露第一条，其余收进「还有 N 步」。
 */
export function ToolActivity({
  steps,
  onOpenFile,
  autoCollapse = false,
  agentId,
  sessionId,
}: {
  steps: ActivityStep[];
  onOpenFile?: (path: string) => void;
  /** 轮次结束后（开始输出正文）自动收成首条 */
  autoCollapse?: boolean;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  const visibleSteps = useMemo(() => {
    const out: ActivityStep[] = [];
    for (const s of steps) {
      if (s.kind === "tool") {
        if (isSilentAgentTool(s.call.name)) continue;
        out.push(s);
      } else if (s.kind === "reasoning") {
        if (!s.content.trim()) continue;
        out.push(s);
      } else if (s.kind === "compaction") {
        out.push(s);
      }
    }
    return out;
  }, [steps]);

  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(!autoCollapse);
  const [detailMap, setDetailMap] = useState<
    Record<string, { arguments?: string; resultText?: string }>
  >({});
  const hasRunning = visibleSteps.some(
    (s) =>
      (s.kind === "tool" && s.call.status === "running") ||
      (s.kind === "reasoning" && s.active) ||
      (s.kind === "compaction" && s.active),
  );
  /**
   * 只折叠「历史记录」里的长链。本轮眼看着跑出来的步骤不折，
   * 否则运行结束的一瞬间列表会突然缩掉一大截——但 autoCollapse 在正文出现后要折。
   */
  const streamedRef = useRef(false);
  useEffect(() => {
    if (hasRunning) {
      streamedRef.current = true;
      setExpanded(true);
    } else if (autoCollapse) {
      setExpanded(false);
    }
  }, [hasRunning, autoCollapse]);

  const hydratedSteps = useMemo(
    () =>
      visibleSteps.map((s) => {
        if (s.kind !== "tool") return s;
        const d = detailMap[s.call.toolCallId];
        if (!d) return s;
        return {
          kind: "tool" as const,
          call: {
            ...s.call,
            arguments: d.arguments ?? s.call.arguments,
            resultText: d.resultText ?? s.call.resultText,
            detailPending: false,
          },
        };
      }),
    [visibleSteps, detailMap],
  );

  const prefetchPending = async () => {
    if (!agentId || !sessionId) return;
    const pending = visibleSteps
      .filter(
        (s): s is Extract<ActivityStep, { kind: "tool" }> =>
          s.kind === "tool" && Boolean(s.call.detailPending) && !detailMap[s.call.toolCallId],
      )
      .map((s) => s.call.toolCallId);
    if (pending.length === 0) return;
    try {
      const { getCloudToolDetails } = await import("@/lib/cloud-agent");
      const res = await getCloudToolDetails(agentId, sessionId, pending);
      setDetailMap((prev) => {
        const next = { ...prev };
        for (const row of res.tools) {
          next[row.toolCallId] = {
            arguments: row.arguments,
            resultText: row.resultText,
          };
        }
        return next;
      });
    } catch {
      /* 单行展开时还会再拉 */
    }
  };

  const compact =
    autoCollapse && !expanded && !hasRunning && hydratedSteps.length > 1;

  const collapsible =
    !compact &&
    hydratedSteps.length > COLLAPSE_THRESHOLD &&
    !hasRunning &&
    !streamedRef.current;
  const middle = useMemo(
    () =>
      collapsible
        ? hydratedSteps.slice(HEAD_ROWS, hydratedSteps.length - TAIL_ROWS)
        : [],
    [hydratedSteps, collapsible],
  );

  if (hydratedSteps.length === 0) return null;

  const row = (s: ActivityStep, i: number) => {
    if (s.kind === "reasoning") {
      return (
        <ReasoningStepRow
          key={`r-${s.id}-${i}`}
          id={s.id}
          content={s.content}
          active={s.active}
        />
      );
    }
    if (s.kind === "compaction") {
      return <CompactionStepRow key={`c-${s.id}-${i}`} step={s} />;
    }
    return (
      <ToolRow
        key={`${s.call.toolCallId}-${i}`}
        call={s.call}
        onOpenFile={onOpenFile}
        agentId={agentId}
        sessionId={sessionId}
      />
    );
  };

  if (compact) {
    const first = hydratedSteps[0]!;
    const rest = hydratedSteps.length - 1;
    return (
      <div className="relative flex w-full min-w-0 flex-col items-start">
        <span
          aria-hidden
          className="animate-rail pointer-events-none absolute top-[15px] bottom-[15px] left-[9px] w-px bg-border/70"
        />
        {row(first, 0)}
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            void prefetchPending();
          }}
          className="group/more -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[12.5px] text-muted-foreground/70 transition-colors duration-150 hover:text-foreground"
        >
          <span className="relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-background">
            <ChevronRight className="size-3 opacity-60" />
          </span>
          <span>还有 {rest} 步</span>
        </button>
      </div>
    );
  }

  const head = collapsible ? hydratedSteps.slice(0, HEAD_ROWS) : hydratedSteps;
  const tail = collapsible
    ? hydratedSteps.slice(hydratedSteps.length - TAIL_ROWS)
    : [];

  return (
    <div className="relative flex w-full min-w-0 flex-col items-start">
      <span
        aria-hidden
        className="animate-rail pointer-events-none absolute top-[15px] bottom-[15px] left-[9px] w-px bg-border/70"
      />
      {head.map(row)}
      {collapsible && (
        <>
          <MoreStepsRow
            count={middle.length}
            open={showAll}
            onToggle={() => {
              setShowAll((v) => !v);
              if (!showAll) void prefetchPending();
            }}
          />
          <Disclosure open={showAll} className="w-full">
            <div className="flex flex-col items-start">
              {middle.map((s, i) => row(s, i + HEAD_ROWS))}
            </div>
          </Disclosure>
        </>
      )}
      {tail.map((s, i) => row(s, i + hydratedSteps.length - TAIL_ROWS))}
      {autoCollapse && expanded && hydratedSteps.length > 1 && !hasRunning && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="group/more -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[12.5px] text-muted-foreground/70 transition-colors duration-150 hover:text-foreground"
        >
          <span className="relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-background">
            <ChevronRight className="size-3 rotate-90 opacity-60" />
          </span>
          <span>收起</span>
        </button>
      )}
    </div>
  );
}

/** 上下文压缩：与工具同轨、更低调，不抢正文 */
function CompactionStepRow({
  step,
}: {
  step: Extract<ActivityStep, { kind: "compaction" }>;
}) {
  const [open, setOpen] = useState(false);
  const active = step.active;
  const failed = Boolean(step.failed);
  const saved = Math.max(0, step.beforeChars - step.afterChars);
  const savedTokens = saved > 0 ? Math.round(saved / 4) : 0;
  const sourceLabel =
    step.source === "manual"
      ? "手动"
      : step.source === "soft"
        ? "预压"
        : step.source === "overflow"
          ? "溢出恢复"
          : step.source === "fork"
            ? "派生"
            : null;
  const activeLabel =
    step.phase === "summarizing" ? "生成摘要…" : "压缩上下文…";
  const doneLabel = failed ? "压缩已降级" : "已压缩上下文";
  const meta: string[] = [];
  if (sourceLabel) meta.push(sourceLabel);
  if (!active && savedTokens > 0 && !failed) {
    meta.push(`约释放 ${savedTokens.toLocaleString("zh-CN")} tokens`);
  }
  if (!active && step.droppedMessages > 0) {
    meta.push(`摘要 ${step.droppedMessages} 条`);
  }
  if (!active && step.durationMs != null && step.durationMs > 0) {
    meta.push(formatMs(step.durationMs));
  }
  if (!active && step.model && step.model !== "default") {
    meta.push(step.model);
  }

  return (
    <div className="flex max-w-full min-w-0 flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        disabled={active && !step.summary}
        onClick={() => {
          if (active && !step.summary) return;
          setOpen((v) => !v);
        }}
        className={cn(
          "group/row -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[13px] text-muted-foreground/75",
          "transition-colors duration-150 ease-fluid hover:text-muted-foreground",
          failed && "text-muted-foreground/65",
        )}
      >
        <StatusIcon running={active} error={failed} Icon={Layers} />
        <span className={cn("min-w-0 truncate", active && "text-shimmer")}>
          {active ? activeLabel : doneLabel}
        </span>
        {meta.length > 0 ? (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground/50">
            {meta.join(" · ")}
          </span>
        ) : null}
        {step.summary ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/35 transition-transform duration-200 ease-fluid",
              open && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {active ? (
        <div className="ml-[22px] w-[min(16rem,100%)] py-0.5">
          <ProgressLinear
            value={
              typeof step.progress === "number"
                ? Math.max(8, Math.min(92, step.progress))
                : null
            }
            indeterminate={step.progress == null}
            className="h-0.5 opacity-60"
          />
        </div>
      ) : null}
      {open && step.summary ? (
        <div
          className={cn(
            DETAIL_WIDTH,
            "ml-[22px] mt-0.5 max-h-40 overflow-auto rounded-md border border-border/40 bg-muted/15 px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground/80",
          )}
        >
          <pre className="whitespace-pre-wrap break-words font-sans">{step.summary}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ReasoningStepRow({
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
    if (active && !wasActive) setOpen(true);
    else if (!active && wasActive) setOpen(false);
    wasActiveRef.current = active;
  }, [active]);

  return (
    <div className="flex max-w-full min-w-0 flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`reasoning-${id}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/row -ml-1.5 flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1.5 text-left text-[13px] text-muted-foreground/85",
          "transition-colors duration-150 ease-fluid hover:text-foreground",
        )}
      >
        <span
          className={cn(
            "relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-background",
          )}
        >
          {active ? (
            <span
              className="size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/50 border-t-transparent"
              aria-hidden
            />
          ) : (
            <Brain className="size-3.5 opacity-60" />
          )}
        </span>
        <span className={cn("min-w-0 truncate", active && "text-shimmer")}>
          {active ? "思考中…" : "思考过程"}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 transition-transform duration-200 ease-fluid",
            open && "rotate-90",
          )}
        />
      </button>
      <Disclosure open={open} className="w-full max-w-[min(100%,42rem)]">
        <div id={`reasoning-${id}`} className="min-w-0 py-1 pr-1 pl-[26px]">
          <ChatMarkdown
            content={content}
            final={!active}
            fade={active}
            variant="muted"
          />
        </div>
      </Disclosure>
    </div>
  );
}
