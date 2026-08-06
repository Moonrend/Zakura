"use client";

import { useParams } from "next/navigation";
import { AgentDetailProvider } from "@/components/agent-detail-context";

export default function AgentSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <AgentDetailProvider key={id} id={id}>
      {children}
    </AgentDetailProvider>
  );
}
