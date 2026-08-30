"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { SkillStorePanel } from "@/components/skills/skill-store-panel";

export default function AgentSkillsAddPage() {
  const { id } = useParams<{ id: string }>();
  const [agents, setAgents] = useState<AgentListItem[]>([]);

  useEffect(() => {
    void fetchAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  return (
    <div className="space-y-4">
      <Link
        href={`/dashboard/agents/${id}/skills`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        技能
      </Link>

      <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
        添加技能
      </h1>

      <SkillStorePanel
        agents={agents}
        defaultAgentIds={[id]}
        onInstalled={() => {
          window.history.back();
        }}
      />
    </div>
  );
}
