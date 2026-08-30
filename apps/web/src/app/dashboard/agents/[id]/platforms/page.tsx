"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentPlatformsPanel } from "@/components/agent-platforms-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";

export default function AgentPlatformsPage() {
  const { id, agent } = useAgentDetail();

  if (!agent) return <PageLoading />;

  return (
    <div className="space-y-5">
      <SettingsHeader title="平台" />
      <AgentPlatformsPanel agentId={id} />
    </div>
  );
}
