"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { McpImportPanel } from "@/components/mcp/import-panel";
import { McpInstallDialog } from "@/components/mcp/install-dialog";
import type { McpInstallPhase } from "@/components/mcp/install-flow";
import { McpServerCard } from "@/components/mcp/server-card";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import {
  CURATED_OAUTH_MCPS,
  oauthTierBadge,
  type UnifiedMcpConfig,
} from "@/lib/mcp-config";

type InstalledRow = {
  id: string;
  name: string;
  slug: string;
  endpointUrl?: string | null;
};

type Props = {
  busy?: boolean;
  onBack: () => void;
  onContinue: () => void;
  onInstalled: (instanceIds: string[]) => Promise<void> | void;
};

const FEATURED_IDS = new Set(["context7", "notion", "linear", "github", "figma", "cloudflare"]);

function isInstalled(mcp: UnifiedMcpConfig, list: InstalledRow[]) {
  const url = mcp.mcpUrl?.replace(/\/$/, "").toLowerCase();
  return list.some((instance) => {
    if (instance.name.toLowerCase() === mcp.name.toLowerCase()) return true;
    if (instance.slug.toLowerCase().includes(mcp.id)) return true;
    return Boolean(
      url && instance.endpointUrl?.replace(/\/$/, "").toLowerCase() === url,
    );
  });
}

export function StepMcpSetup({ busy, onBack, onContinue, onInstalled }: Props) {
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [binding, setBinding] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setInstalled(await api<InstalledRow[]>("/api/instances"));
    } catch {
      /* 页面仍可展示目录 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function complete(instanceIds: string[]) {
    setBinding(true);
    try {
      await onInstalled(instanceIds);
      await refresh();
      setAddedCount((count) => count + instanceIds.length);
      toast.success("MCP 已添加到 Agent");
    } finally {
      setBinding(false);
    }
  }

  const featured = CURATED_OAUTH_MCPS.filter((mcp) => FEATURED_IDS.has(mcp.id));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        disabled={binding || busy}
        onClick={onBack}
      >
        <ArrowLeft />
        返回选择
      </Button>
      <SettingsHeader title="添加 MCP 能力" />

      <Tabs defaultValue="featured">
        <TabsList variant="line" className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="featured">精选 MCP</TabsTrigger>
          <TabsTrigger value="upstream">添加上游 MCP</TabsTrigger>
        </TabsList>

        <TabsContent value="featured" className="mt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {featured.map((mcp) => (
              <FeaturedMcpCard
                key={mcp.id}
                mcp={mcp}
                installed={isInstalled(mcp, installed)}
                disabled={binding || busy}
                onInstalled={(id) => void complete([id])}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="upstream" className="mt-4">
          <div>
            <div className="mb-4">
              <p className="text-sm font-medium">添加上游 MCP</p>
            </div>
            <McpImportPanel
              embedded
              onComplete={({ instanceIds }) => void complete(instanceIds)}
            />
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between gap-3 border-t border-border/80 pt-4">
        <p className="text-xs text-muted-foreground">
          {addedCount > 0 ? `已添加 ${addedCount} 个 MCP 能力` : "MCP 是可选的，可直接继续"}
        </p>
        <Button disabled={binding || busy} onClick={onContinue}>
          {binding ? <Loader2 className="animate-spin" /> : null}
          接入代理工具
          {!binding ? <ArrowRight /> : null}
        </Button>
      </div>
    </div>
  );
}

function FeaturedMcpCard({
  mcp,
  installed,
  disabled,
  onInstalled,
}: {
  mcp: UnifiedMcpConfig;
  installed: boolean;
  disabled?: boolean;
  onInstalled: (instanceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<McpInstallPhase>("idle");
  const [installedLocal, setInstalledLocal] = useState(installed);
  const tier = oauthTierBadge(mcp);

  useEffect(() => setInstalledLocal(installed), [installed]);

  return (
    <>
      <McpServerCard
        server={{
          id: mcp.id,
          title: mcp.name,
          description: mcp.description,
          subtitle: mcp.mcpUrl,
          brandId: mcp.oauth?.providerId ?? mcp.id,
          mcpUrl: mcp.mcpUrl,
          homepage: mcp.docsUrl,
          badges: [{ label: tier.label, variant: tier.variant }],
          installed: installedLocal,
        }}
        busy={disabled}
        installPhase={phase}
        installLabel="添加"
        onInstall={() => setOpen(true)}
      />
      <McpInstallDialog
        open={open}
        onOpenChange={setOpen}
        config={mcp}
        onPhaseChange={setPhase}
        onComplete={(result) => {
          setInstalledLocal(true);
          onInstalled(result.instanceId);
        }}
      />
    </>
  );
}
