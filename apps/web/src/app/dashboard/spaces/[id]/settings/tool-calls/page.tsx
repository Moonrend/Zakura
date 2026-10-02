"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { ToolCallsPanel } from "@/components/tool-calls/tool-calls-panel";

export default function AgentToolCallsPage() {
  const { id } = useAgentDetail();
  return (
    <ToolCallsPanel
      title="调用记录"
      agentId={id}
      showAgentFilter={false}
    />
  );
}
