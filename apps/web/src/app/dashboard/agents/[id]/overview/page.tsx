"use client";

import Link from "next/link";
import {
  Brain,
  Cable,
  Globe,
  HardDrive,
  MessageSquare,
  Plug,
  Settings2,
  Sparkles,
  Wrench,
  ArrowUpRight,
} from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentConnectPanel } from "@/components/agent-connect-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const QUICK_LINKS = [
  { href: "settings", label: "设置", icon: Settings2, hint: "模型与行为" },
  { href: "computer", label: "电脑", icon: HardDrive, hint: "工作区容器" },
  { href: "web", label: "网页", icon: Globe, hint: "搜索与抓取" },
  { href: "memory", label: "记忆", icon: Brain, hint: "长期记忆" },
  { href: "skills", label: "技能", icon: Sparkles, hint: "Skill 包" },
  { href: "mcp", label: "MCP", icon: Cable, hint: "工具绑定" },
  { href: "platforms", label: "消息平台", icon: MessageSquare, hint: "外部渠道" },
  { href: "tool-calls", label: "调用记录", icon: Wrench, hint: "工具轨迹" },
] as const;

export default function AgentOverviewPage() {
  const { id, agent, loading } = useAgentDetail();

  if (loading || !agent) {
    return (
      <div className="space-y-8">
        <div className="space-y-3 pt-1">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-9 w-56 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="space-y-1.5">
          <code className="text-[11px] text-muted-foreground">{agent.slug}</code>
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {agent.name}
          </h1>
          {agent.description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {agent.description}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            nativeButton={false}
            render={<Link href={`/chat?agent=${id}`} />}
          >
            <MessageSquare className="size-4" />
            开始对话
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={`/dashboard/agents/${id}/settings`} />}
          >
            <Settings2 className="size-4" />
            设置
          </Button>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">模块</h2>
        <div className="stagger-children grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={`/dashboard/agents/${id}/${item.href}`}
                className={cn(
                  "group flex items-start gap-3 rounded-lg border border-border bg-card p-3",
                  "surface-interactive hover:border-foreground/15",
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-sm font-medium">
                    {item.label}
                    <ArrowUpRight className="size-3.5 opacity-0 transition-opacity duration-150 group-hover:opacity-50" />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{item.hint}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section id="access" className="scroll-mt-24 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Plug className="size-4 text-muted-foreground" />
          接入与凭据
        </h2>
        <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
          <AgentConnectPanel
            agentId={id}
            agentSlug={agent.slug}
            mcpAgentUrl={agent.mcpAgentUrl}
          />
        </div>
      </section>
    </div>
  );
}
