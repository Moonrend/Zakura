"use client";

import Link from "next/link";
import {
  AlarmClock,
  Brain,
  Cable,
  FolderKanban,
  Globe,
  HardDrive,
  MessageSquare,
  Plug,
  Settings2,
  Blocks,
  Wrench,
  ArrowUpRight,
} from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";

const QUICK_LINKS = [
  { href: "settings", label: "设置", icon: Settings2, hint: "模型、指令与 Agent 行为" },
  { href: "computer", label: "电脑", icon: HardDrive, hint: "容器与开发环境" },
  { href: "projects", label: "项目", icon: FolderKanban, hint: "系统指令与知识库" },
  { href: "skills", label: "技能", icon: Blocks, hint: "预装能力扩展" },
  { href: "web", label: "网页", icon: Globe, hint: "网页搜索与内容抓取" },
  { href: "memory", label: "记忆", icon: Brain, hint: "跨会话长期记忆" },
  { href: "mcp", label: "MCP", icon: Cable, hint: "MCP 工具服务器" },
  { href: "connect", label: "接入", icon: Plug, hint: "对外 MCP 端点与凭据" },
  { href: "gateway", label: "AI Gateway", icon: Plug, hint: "统一模型代理" },
  { href: "platforms", label: "消息平台", icon: MessageSquare, hint: "Slack、飞书等渠道" },
  { href: "automation", label: "自动化", icon: AlarmClock, hint: "定时与事件触发" },
  { href: "tool-calls", label: "调用记录", icon: Wrench, hint: "工具调用历史" },
] as const;

export default function AgentOverviewPage() {
  const { id, agent, loading } = useAgentDetail();

  if (loading || !agent) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="space-y-1.5">
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
        <h2 className="text-sm font-medium">配置</h2>
        <div className="stagger-rows grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={`/dashboard/agents/${id}/${item.href}`}
                className={cn(
                  "animate-rise group flex min-h-[4.5rem] items-start gap-3 rounded-lg border border-border bg-card p-3",
                  "surface-interactive hover:border-foreground/15",
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
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

    </div>
  );
}
