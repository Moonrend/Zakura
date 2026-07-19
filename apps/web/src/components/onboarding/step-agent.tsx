"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type OnboardingAgent = {
  id: string;
  name: string;
  slug: string;
  mcpAgentUrl?: string;
};

type Props = {
  agents: OnboardingAgent[];
  onDone: (agent: OnboardingAgent) => void;
};

export function StepCreateAgent({ agents, onDone }: Props) {
  const existing = agents[0];
  const [name, setName] = useState(existing?.name ?? "");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        onDone(existing);
        return;
      }
      const res = await api<OnboardingAgent & { mcpAgentUrl: string }>(
        "/api/agents",
        {
          method: "POST",
          json: { name: name.trim(), createApiKey: false },
        },
      );
      toast.success("已创建");
      onDone({
        id: res.id,
        name: res.name,
        slug: res.slug,
        mcpAgentUrl: res.mcpAgentUrl,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="agent-name">名称</Label>
        <Input
          id="agent-name"
          placeholder="例如：主助手"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          disabled={!!existing}
          autoFocus={!existing}
        />
      </div>
      <Button disabled={busy} onClick={() => void create()}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {existing ? "继续" : "创建"}
      </Button>
    </div>
  );
}
