"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, ChevronDown, FolderGit2, Loader2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { RuntimeIcon } from "./runtime-icon";

export type SessionRuntimeOption = { id: string; label: string };

function ContextTrigger({
  icon,
  label,
  title,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      title={title}
      {...props}
      className={cn(
        "inline-flex max-w-[14rem] items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-foreground/85",
        "hover:bg-muted disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
    >
      {icon}
      {label ? <span className="min-w-0 truncate">{label}</span> : null}
      <ChevronDown className="size-3 shrink-0 opacity-45" />
    </button>
  );
}

export function SessionContextBar({
  isNew,
  project,
  projects,
  onProjectChange,
  runtimes,
  runtimeId,
  runtimeDisabled,
  runtimeLoading,
  runtimeDisabledHint,
  onRuntimeChange,
}: {
  isNew: boolean;
  project: string | null;
  projects: string[];
  onProjectChange: (project: string | null) => void;
  runtimes: SessionRuntimeOption[];
  runtimeId: string;
  runtimeDisabled?: boolean;
  runtimeLoading?: boolean;
  runtimeDisabledHint?: string;
  onRuntimeChange: (id: string) => void;
}) {
  const current = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
  const projectNames =
    project && !projects.includes(project) ? [project, ...projects] : projects;

  return (
    <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-[13px] text-muted-foreground">
      {project ? (
        <>
          <span>{isNew ? "新会话位于" : "位于"}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <ContextTrigger
                  icon={<FolderGit2 className="size-3.5 shrink-0" />}
                  label={project}
                  title="更换项目"
                />
              }
            />
            <DropdownMenuContent align="start" side="top" sideOffset={6} className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>项目</DropdownMenuLabel>
                {projectNames.map((name) => (
                  <DropdownMenuItem key={name} onClick={() => onProjectChange(name)}>
                    <FolderGit2 />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {project === name ? <Check className="size-3.5" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onProjectChange(null)}>
                不绑定项目
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span>使用</span>
        </>
      ) : (
        <span>使用</span>
      )}

      {runtimes.length > 1 || (!project && projects.length > 0) ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={runtimeDisabled}
            title={runtimeDisabled ? runtimeDisabledHint : "选择执行 Agent"}
            render={
              <ContextTrigger
                icon={
                  runtimeLoading ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <RuntimeIcon id={current?.id ?? runtimeId} />
                  )
                }
                label={current?.label ?? runtimeId}
                disabled={runtimeDisabled}
              />
            }
          />
          <DropdownMenuContent align="start" side="top" sideOffset={6} className="min-w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>执行 Agent</DropdownMenuLabel>
              {runtimes.map((r) => (
                <DropdownMenuItem key={r.id} onClick={() => onRuntimeChange(r.id)}>
                  <RuntimeIcon id={r.id} />
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.id === runtimeId ? <Check className="size-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {!project && projects.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>项目</DropdownMenuLabel>
                  {projects.map((name) => (
                    <DropdownMenuItem key={name} onClick={() => onProjectChange(name)}>
                      <FolderGit2 />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="inline-flex items-center gap-1 px-1 text-foreground/85">
          {runtimeLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RuntimeIcon id={current?.id ?? runtimeId} />
          )}
          <span className="truncate">{current?.label ?? runtimeId}</span>
        </span>
      )}

      {runtimeLoading ? <span className="text-xs">启动中…</span> : null}
    </div>
  );
}
