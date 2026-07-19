"use client";

import { useParams } from "next/navigation";
import { ToolCallsPanel } from "@/components/tool-calls/tool-calls-panel";

export default function AgentToolCallsPage() {
  const params = useParams<{ id: string }>();
  return (
    <ToolCallsPanel
      title="调用记录"
      agentId={params.id}
      showAgentFilter={false}
    />
  );
}
