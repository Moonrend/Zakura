"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type Provider = {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
};

type Props = {
  agentId: string | null;
  onDone: () => void;
};

export function StepMemory({ agentId, onDone }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const res = await api<{
          providers: Provider[];
          agents: Array<{
            id: string;
            enableMemory: boolean;
            memoryProviderId: string | null;
          }>;
        }>("/api/memory-providers");
        setProviders(res.providers);
        const agent = res.agents.find((a) => a.id === agentId);
        const def = res.providers.find((p) => p.isDefault) ?? res.providers[0];
        if (agent?.memoryProviderId) setProviderId(agent.memoryProviderId);
        else if (def) setProviderId(def.id);
        if (agent) setEnabled(agent.enableMemory);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId]);

  async function save() {
    if (!agentId) return;
    setBusy(true);
    try {
      let pid = providerId;
      if (enabled && !pid) {
        const created = await api<Provider>("/api/memory-providers", {
          method: "POST",
          json: {
            name: "Built-in",
            kind: "builtin",
            isDefault: true,
            config: { defaultUserId: "default", maxChars: 32000 },
          },
        });
        pid = created.id;
        setProviders((p) => [...p, created]);
        setProviderId(pid);
      }
      await api(`/api/agents/${agentId}`, {
        method: "PATCH",
        json: {
          enableMemory: enabled,
          memoryProviderId: enabled ? pid : null,
        },
      });
      toast.success("已保存");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!agentId) {
    return <p className="text-sm text-muted-foreground">请先创建 Agent。</p>;
  }
  if (loading) return <Skeleton className="h-28 w-full rounded-lg" />;

  const items = providers.map((p) => ({
    value: p.id,
    label: `${p.name} · ${p.kind}`,
  }));

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="mem-enable">开启记忆</Label>
        <Switch id="mem-enable" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {enabled ? (
        <div className="space-y-1.5">
          <Label>提供商</Label>
          {providers.length ? (
            <Select
              value={providerId}
              onValueChange={(v) => {
                if (v) setProviderId(v);
              }}
              items={items}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择提供商" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground">Built-in</p>
          )}
        </div>
      ) : null}

      <Button disabled={busy} onClick={() => void save()}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        保存并继续
      </Button>
    </div>
  );
}
