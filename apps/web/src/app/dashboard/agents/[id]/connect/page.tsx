"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentConnectPanel } from "@/components/agent-connect-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentConnectPage() {
  const { id, agent } = useAgentDetail();

  if (!agent) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader title="接入" />
      <AgentConnectPanel
        agentId={id}
        agentSlug={agent.slug}
        mcpAgentUrl={agent.mcpAgentUrl}
      />
    </div>
  );
}
