"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { ComputerCatalog } from "@/components/computer-catalog";
import { PageLoading } from "@/components/ui/progress-linear";

export default function AgentComputerPage() {
  const { agent } = useAgentDetail();

  if (!agent) {
    return <PageLoading />;
  }

  if (!agent.spaceId) {
    return (
      <p className="text-sm text-muted-foreground">该 Agent 不属于任何 Space。</p>
    );
  }

  return <ComputerCatalog spaceId={agent.spaceId} />;
}
