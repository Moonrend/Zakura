"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CURATED_OAUTH_MCPS, oauthTierBadge, type UnifiedMcpConfig } from "@/lib/mcp-config";
import { api } from "@/lib/api";
import { McpServerCard } from "@/components/mcp/server-card";
import { McpInstallDialog } from "@/components/mcp/install-dialog";
import type { McpInstallPhase } from "@/components/mcp/install-flow";

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

function OnboardingInstallCard({
  mcp,
  installed,
  onInstalled,
}: {
  mcp: UnifiedMcpConfig;
  installed: boolean;
  onInstalled: (meta: { dialogWasOpen: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [installPhase, setInstallPhase] = useState<McpInstallPhase>("idle");
  const [installedLocal, setInstalledLocal] = useState(installed);
  const tier = oauthTierBadge(mcp);

  useEffect(() => {
    setInstalledLocal(installed);
  }, [installed]);

  return (
    <>
      <McpServerCard
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
          installed: installedLocal,
        }}
        installPhase={installPhase}
        onInstall={() => setOpen(true)}
      />
      <McpInstallDialog
        open={open}
        onOpenChange={setOpen}
        config={mcp}
        onPhaseChange={setInstallPhase}
        onComplete={(_result, meta) => {
          setInstalledLocal(true);
          setInstallPhase("done");
          toast.success(`${mcp.name} 已接入`);
          onInstalled(meta);
        }}
      />
    </>
  );
}

export function StepMcpConnect({ onDone }: Props) {
  const [installed, setInstalled] = useState<InstalledRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await api<InstalledRow[]>("/api/instances");
      setInstalled(
        list.filter(
          (i) =>
            i.providerId === "generic-mcp" ||
            i.providerId === "stdio-mcp" ||
            i.providerId === "openviking" ||
            i.providerId === "google-workspace",
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
        {CURATED_OAUTH_MCPS.map((mcp) => (
          <OnboardingInstallCard
            key={mcp.id}
            mcp={mcp}
            installed={isInstalled(mcp, installed)}
            onInstalled={() => {
              void refresh();
              onDone();
            }}
          />
        ))}
      </div>
    </div>
  );
}
