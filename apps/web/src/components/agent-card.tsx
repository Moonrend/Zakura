"use client";

import Link from "next/link";
import { ArrowUpRight, MessageSquare, Settings2 } from "lucide-react";
import { type AgentListItem } from "@/lib/agents";
import { chatAgentHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FluidItem } from "@/components/ui/fluid-hover";

const ACTION_LINK = cn(
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground",
  "transition-[background-color,color,transform] duration-150 ease-fluid",
  "hover:bg-hover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
  "press",
);

export function AgentCard({
  agent,
  baseHref,
}: {
  agent: AgentListItem;
  baseHref: string;
}) {
  const initial = agent.name.trim().slice(0, 1).toUpperCase() || "A";

  return (
    <FluidItem>
      <div className="group relative flex items-center gap-3 rounded-xl bg-card p-3 shadow-surface-2 sm:h-full sm:min-h-[10rem] sm:flex-col sm:items-stretch sm:p-4">
        <Link
          href={`${baseHref}/overview`}
          className="absolute inset-0 z-[1] rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-label={`${agent.name} 概览`}
        />

        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium">
          {initial}
        </span>

        <div className="min-w-0 flex-1 sm:mt-auto sm:pt-6">
          <h3 className="truncate text-sm font-medium tracking-tight">{agent.name}</h3>
          {agent.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground sm:mt-1 sm:line-clamp-2 sm:leading-relaxed">
              {agent.description}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{agent.slug}</p>
          )}
          {agent.spaceName ? (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
              {agent.spaceName}
            </p>
          ) : null}
        </div>

        <div
          className={cn(
            "relative z-[2] hidden items-center gap-0.5 sm:flex",
            "opacity-0 transition-opacity duration-150 ease-fluid",
            "group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <Link href={chatAgentHref(agent.id)} className={ACTION_LINK} title="对话">
            <MessageSquare className="size-3.5" />
          </Link>
          <Link href={`${baseHref}/settings`} className={ACTION_LINK} title="设置">
            <Settings2 className="size-3.5" />
          </Link>
          <Link href={`${baseHref}/overview`} className={ACTION_LINK} title="详情">
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </FluidItem>
  );
}
