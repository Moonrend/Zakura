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
  Bot,
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
        <div className="space-y-4 pt-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-14 w-72 max-w-full" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/40 px-5 py-8 sm:px-8 sm:py-10">
        {/* Diffuse glow blobs */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 -top-20 size-72 rounded-full bg-primary/20 blur-3xl dark:bg-primary/15"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 top-0 size-64 rounded-full bg-sky-500/15 blur-3xl dark:bg-sky-400/10"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-1/3 size-56 rounded-full bg-violet-500/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/[0.07] via-transparent to-transparent"
        />

        <div className="relative space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
              <Bot className="size-3" />
              Agent
            </span>
            <code className="rounded-md bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {agent.slug}
            </code>
          </div>

          <div className="relative">
            {/* Soft text glow layer */}
            <h1
              aria-hidden
              className="pointer-events-none absolute inset-0 select-none font-heading text-4xl font-semibold tracking-tight text-primary/40 blur-xl sm:text-5xl md:text-6xl"
            >
              {agent.name}
            </h1>
            <h1 className="relative font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl">
              <span className="bg-gradient-to-br from-foreground via-foreground to-foreground/70 bg-clip-text">
                {agent.name}
              </span>
            </h1>
          </div>

          {agent.description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {agent.description}
            </p>
          ) : (
            <p className="max-w-2xl text-sm text-muted-foreground/80">
              尚未添加描述。可在设置中完善 Agent 信息。
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
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
              高级设置
            </Button>
          </div>
        </div>
      </section>

      {/* Quick nav */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium tracking-tight">配置入口</h2>
            <p className="text-xs text-muted-foreground">快速跳转到各能力模块</p>
          </div>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={`/dashboard/agents/${id}/${item.href}`}
                className={cn(
                  "group flex items-start gap-3 rounded-xl border border-border/80 bg-card p-3.5",
                  "shadow-[var(--shadow-soft)] transition-[border-color,background-color,transform] duration-200 ease-out-soft",
                  "hover:border-foreground/20 hover:bg-muted/30",
                )}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-sm font-medium">
                    {item.label}
                    <ArrowUpRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{item.hint}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Access / API key / MCP */}
      <section id="access" className="scroll-mt-24 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium tracking-tight">
              <Plug className="size-4 text-muted-foreground" />
              接入与凭据
            </h2>
            <p className="text-xs text-muted-foreground">
              MCP 地址、访问 Key，以及客户端配置片段
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-border/80 bg-card p-4 shadow-[var(--shadow-soft)] sm:p-5">
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
