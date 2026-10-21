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
        "inline-flex h-7 max-w-[min(14rem,60vw)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none",
        "transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className="size-3 shrink-0 opacity-45" />
    </button>
  );
}

export function SessionContextBar({
  project,
  projects,
  onProjectChange,
  runtimes,
  runtimeId,
  runtimeDisabled,
  runtimeLoading,
  runtimeDisabledHint,
  onRuntimeChange,
  flashProject,
  flashRuntime,
}: {
  project: string | null;
  projects: string[];
  onProjectChange: (project: string | null) => void;
  runtimes: SessionRuntimeOption[];
  runtimeId: string;
  runtimeDisabled?: boolean;
  runtimeLoading?: boolean;
  runtimeDisabledHint?: string;
  onRuntimeChange: (id: string) => void;
  flashProject?: number;
  flashRuntime?: number;
}) {
  const current = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
  const projectNames =
    project && !projects.includes(project) ? [project, ...projects] : projects;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <DropdownMenu key={flashRuntime ? `runtime-${flashRuntime}` : "runtime"}>
        <DropdownMenuTrigger
          disabled={runtimeDisabled || runtimes.length < 2}
          render={
            <ContextTrigger
              aria-label="选择执行 Agent"
              title={runtimeLoading ? "Agent 启动中" : runtimeDisabled ? runtimeDisabledHint : "选择执行 Agent"}
              icon={
                runtimeLoading ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <RuntimeIcon id={current?.id ?? runtimeId} />
                )
              }
              label={current?.label ?? runtimeId}
              className={flashRuntime ? "animate-remote-nudge" : undefined}
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
        </DropdownMenuContent>
      </DropdownMenu>

      {projectNames.length > 0 ? (
        <DropdownMenu key={flashProject ? `project-${flashProject}` : "project"}>
          <DropdownMenuTrigger
            render={
              <ContextTrigger
                aria-label="选择项目"
                icon={<FolderGit2 className="size-3.5 shrink-0" />}
                label={project ?? "项目"}
                title={project ?? "选择项目"}
                className={flashProject ? "animate-remote-nudge" : undefined}
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
              {!project ? <Check className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
