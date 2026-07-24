"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentGeneralPage() {
  const { id, agent, refresh } = useAgentDetail();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (agent) setName(agent.name);
  }, [agent]);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        json: {
          name: name.trim() || undefined,
        },
      });
      toast.success("已保存");
      await refresh({ list: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!agent) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-36 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="概览"
        actions={
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
        }
      />

      <SettingsSection>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="name">名称</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" className="font-mono text-xs" value={agent.slug} readOnly />
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
