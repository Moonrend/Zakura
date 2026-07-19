"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CURATED_OAUTH_MCPS, oauthTierBadge, type UnifiedMcpConfig } from "@/lib/mcp-config";
import { api } from "@/lib/api";
import { McpServerCard } from "@/components/mcp/server-card";
import { McpInstallFlow } from "@/components/mcp/install-flow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type InstalledRow = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  endpointUrl?: string | null;
};

type Props = {
  onDone: () => void;
};

function isInstalled(mcp: UnifiedMcpConfig, list: InstalledRow[]) {
  const url = mcp.mcpUrl?.replace(/\/$/, "").toLowerCase();
  return list.some((i) => {
    if (i.name.toLowerCase() === mcp.name.toLowerCase()) return true;
    if (i.slug.toLowerCase().includes(mcp.id)) return true;
    return !!url && (i.endpointUrl ?? "").replace(/\/$/, "").toLowerCase() === url;
  });
}

export function StepMcpConnect({ onDone }: Props) {
  const [selected, setSelected] = useState<UnifiedMcpConfig | null>(null);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await api<InstalledRow[]>("/api/instances");
      setInstalled(
        list.filter(
          (i) =>
            i.providerId === "generic-mcp" ||
            i.providerId === "stdio-mcp" ||
            i.providerId === "openviking",
        ),
      );
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {CURATED_OAUTH_MCPS.map((mcp) => {
          const tier = oauthTierBadge(mcp);
          return (
            <McpServerCard
              key={mcp.id}
              server={{
                id: mcp.id,
                title: mcp.name,
                subtitle: mcp.mcpUrl,
                description: mcp.description,
                badges: [
                  { label: tier.label, variant: tier.variant },
                  { label: "HTTP", variant: "secondary" },
                ],
                repositoryUrl: mcp.repositoryUrl ?? mcp.docsUrl,
                installed: isInstalled(mcp, installed),
              }}
              onInstall={() => setSelected(mcp)}
            />
          );
        })}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>安装 {selected?.name}</DialogTitle>
            <DialogDescription>
              {selected?.oauth?.tier === "B"
                ? "使用预注册 OAuth App 或访问令牌完成授权。"
                : "OAuth 2.1 授权后即可使用。"}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <McpInstallFlow
              key={selected.id}
              config={selected}
              onComplete={() => {
                void refresh();
                toast.success(`${selected.name} 已接入`);
                setSelected(null);
                onDone();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
