"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentPlatformsPanel } from "@/components/agent-platforms-panel";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { SettingsHeader } from "@/components/settings-shell";

export default function SpacePlatformsPage() {
  const { id } = useAgentDetail();
  const { spaceId, agents } = useSpaceSettings();

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="消息平台"
        description="渠道保存在这个空间里，只存一份。每条渠道指定由哪个 Agent 回复。"
      />
      <AgentPlatformsPanel
        agentId={id}
        spaceId={spaceId}
        memberAgents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
      />
    </div>
  );
}
