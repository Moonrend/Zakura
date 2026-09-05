"use client";

import {
  Archive,
  Check,
  GitFork,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SESSION_KIND_LABELS, type CloudSession } from "@/lib/cloud-agent";
import { chatSessionHref, shouldLetBrowserHandleClick } from "@/lib/nav";

export interface ChatSessionRowProps {
  session: CloudSession;
  agentId: string | null;
  /** 当前打开的会话 */
  sessionId: string | null;
  /** 正在切换中的会话（乐观高亮 + spinner） */
  pendingSessionId: string | null;
  acpRuntimes: { id: string; label: string }[];
  projects: { name: string }[];
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenamingIdChange: (id: string | null) => void;
  onCommitRename: () => void | Promise<void>;
  onLoadSession: (agentId: string, sessionId: string) => void | Promise<void>;
  onCloseNav: () => void;
  onFork: (sessionId: string) => void | Promise<void>;
  onMove: (sessionId: string, project: string | null) => void | Promise<void>;
  onArchive: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
}

/** 侧边栏单条会话：内联重命名 + 操作菜单（Fork / 移动 / 归档 / 删除） */
export function ChatSessionRow({
  session: s,
  agentId,
  sessionId,
  pendingSessionId,
  acpRuntimes,
  projects,
  renamingId,
  renameValue,
  onRenameValueChange,
  onRenamingIdChange,
  onCommitRename,
  onLoadSession,
  onCloseNav,
  onFork,
  onMove,
  onArchive,
  onDelete,
}: ChatSessionRowProps) {
  const isActive = s.id === sessionId || s.id === pendingSessionId;
  return (
    <div
      aria-busy={s.id === pendingSessionId || undefined}
      className={cn(
        "group animate-rise relative flex items-center rounded-lg text-sm",
        "transition-colors duration-150 ease-fluid",
        isActive
          ? "bg-muted text-foreground session-row-active"
          : "text-foreground/75 hover:bg-muted/60 hover:text-foreground/90",
      )}
    >
      {isActive && (
        <span
          aria-hidden
          className="animate-pop absolute top-1/2 left-0 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-foreground/60"
        />
      )}
      {renamingId === s.id ? (
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameValueChange(e.target.value)}
          onBlur={() => void onCommitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCommitRename();
            if (e.key === "Escape") onRenamingIdChange(null);
          }}
          className="mx-1 my-0.5 h-6 px-1 text-sm"
        />
      ) : (
        <>
          {/*
            A real anchor, not a button: the session already has a deep link
            (syncChatUrl writes /chat?agent=…&session=…), so making the row an
            <a href> is what enables right-click "copy link", long-press on
            mobile, and cmd/middle-click into a new tab. The onClick keeps the
            fast in-place load for plain clicks and steps aside otherwise.
          */}
          <a
            href={agentId ? chatSessionHref(agentId, s.id) : undefined}
            className="weight-hover flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1.5 text-left"
            onClick={(e) => {
              if (!agentId || shouldLetBrowserHandleClick(e)) return;
              e.preventDefault();
              void onLoadSession(agentId, s.id);
              onCloseNav();
            }}
          >
            <span className="truncate">{s.title}</span>
            {s.kind === "acp" && s.origin?.acpProfileId ? (
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {acpRuntimes.find((r) => r.id === s.origin?.acpProfileId)?.label ||
                  s.origin?.acpProfileId}
              </span>
            ) : s.kind && s.kind !== "chat" ? (
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {SESSION_KIND_LABELS[s.kind] ?? s.kind}
              </span>
            ) : null}
            {s.origin?.channel === "openai-gateway" ? (
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                Gateway
              </span>
            ) : null}
            {s.id === pendingSessionId ? (
              <Loader2
                aria-label="加载中"
                className="size-3 shrink-0 animate-spin text-muted-foreground"
              />
            ) : s.activeRunId ? (
              <span
                aria-label="运行中"
                className="running-halo relative h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/70 text-foreground/70"
              />
            ) : null}
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="会话操作"
                  className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted max-md:opacity-60 md:opacity-0 md:group-hover:opacity-100 md:data-[popup-open]:opacity-100"
                />
              }
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-28">
              {s.origin?.channel === "openai-gateway" ? (
                <DropdownMenuItem onClick={() => void onFork(s.id)}>
                  <GitFork />
                  Fork 后续聊
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onClick={() => {
                  onRenamingIdChange(s.id);
                  onRenameValueChange(s.title);
                }}
              >
                <Pencil />
                重命名
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>移到项目</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-32">
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.name} onClick={() => void onMove(s.id, p.name)}>
                      {p.name}
                      {s.project === p.name ? <Check className="h-3.5 w-3.5" /> : null}
                    </DropdownMenuItem>
                  ))}
                  {s.project ? (
                    <DropdownMenuItem onClick={() => void onMove(s.id, null)}>
                      移出到其他对话
                    </DropdownMenuItem>
                  ) : null}
                  {projects.length === 0 && !s.project ? (
                    <DropdownMenuItem disabled>暂无项目</DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => void onArchive(s.id)}>
                <Archive />
                归档
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => void onDelete(s.id)}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}