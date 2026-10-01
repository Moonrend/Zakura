"use client";

import { useParams } from "next/navigation";
import { AgentDetailProvider } from "@/components/agent-detail-context";

export default function SpaceAgentLayout({ children }: { children: React.ReactNode }) {
  const { agentId } = useParams<{ id: string; agentId: string }>();
  return (
    <AgentDetailProvider key={agentId} id={agentId}>
      {children}
    </AgentDetailProvider>
  );
}
