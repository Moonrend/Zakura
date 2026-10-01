"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { AgentDetailProvider } from "@/components/agent-detail-context";
import { PageLoading } from "@/components/ui/progress-linear";

/** 这些页的数据跟着某个 Agent（会话、密钥、定时任务），不是空间上的一份配置。 */
const PER_AGENT_SECTIONS = new Set([
  "automation",
  "computer",
  "connect",
  "gateway",
  "projects",
  "tool-calls",
]);

type SpaceSettingsValue = {
  spaceId: string;
  agents: AgentListItem[];
  /** 仍走 Agent API 的页面用来执行安装等操作；配置本身写在空间上。 */
  hostAgentId: string;
};

const SpaceSettingsContext = createContext<SpaceSettingsValue | null>(null);

export function useSpaceSettings(): SpaceSettingsValue {
  const value = useContext(SpaceSettingsContext);
  if (!value) throw new Error("useSpaceSettings must be used within SpaceSettingsLayout");
  return value;
}

export default function SpaceSettingsLayout({
  children,
  spaceId,
}: {
  children: React.ReactNode;
  spaceId: string;
}) {
  const pathname = usePathname();
  const section = pathname.split("/").filter(Boolean).pop() ?? "";
  const perAgent = PER_AGENT_SECTIONS.has(section);
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchAgents();
        if (cancelled) return;
        setAgents(rows.filter((agent) => agent.spaceId === spaceId));
      } catch {
        if (!cancelled) setAgents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (!agents) return <PageLoading />;

  const host = agents.find((agent) => agent.id === pickedId) ?? agents[0];
  if (!host) {
    return (
      <div className="space-y-3 p-2">
        <h1 className="text-lg font-medium">空间设置</h1>
        <p className="text-sm text-muted-foreground">
          这个空间还没有 Agent。ACP、消息渠道和 MCP 会记在空间上，不会按 Agent 各存一份。请先在
          <Link href={`/dashboard/spaces/${spaceId}`} className="mx-1 underline">
            Agents
          </Link>
          里添加一个。
        </p>
      </div>
    );
  }

  return (
    <SpaceSettingsContext.Provider value={{ spaceId, agents, hostAgentId: host.id }}>
      {perAgent && agents.length > 1 ? (
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="space-record-agent" className="text-xs text-muted-foreground">
            当前 Agent
          </label>
          <select
            id="space-record-agent"
            value={host.id}
            onChange={(event) => setPickedId(event.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <AgentDetailProvider key={host.id} id={host.id}>
        {children}
      </AgentDetailProvider>
    </SpaceSettingsContext.Provider>
  );
}
