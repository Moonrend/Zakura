"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import {
  CURATED_MCP_GROUPS,
  CURATED_OAUTH_MCPS,
  oauthTierBadge,
  type UnifiedMcpConfig,
} from "@/lib/mcp-config";
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

function isInstalled(mcp: UnifiedMcpConfig, list: InstalledRow[]) {
  const url = mcp.mcpUrl?.replace(/\/$/, "").toLowerCase();
  return list.some((i) => {
    if (i.name.toLowerCase() === mcp.name.toLowerCase()) return true;
    if (i.slug.toLowerCase().includes(mcp.id)) return true;
    return !!url && (i.endpointUrl ?? "").replace(/\/$/, "").toLowerCase() === url;
  });
}

/** 官方推荐 MCP 商店（与社区 Registry 商店分离） */
export function McpOfficialStorePanel() {
  const router = useRouter();
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
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          精选远程 MCP，按 OAuth 契约分流安装。GitHub / Google
          需先在整站「OAuth 应用」配置客户端（自托管也可在此填写）。
        </p>
        <Link
          href="/dashboard/settings/oauth-apps"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-muted/60"
        >
          <KeyRound className="size-3.5" />
          OAuth 应用
        </Link>
      </div>

      {CURATED_MCP_GROUPS.map((group) => {
        const items = CURATED_OAUTH_MCPS.filter((m) => m.group === group.id);
        if (!items.length) return null;
        return (
          <section key={group.id} className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{group.title}</h2>
              <p className="text-xs text-muted-foreground">{group.description}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((mcp) => {
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
                        { label: "官方", variant: "default" },
                        { label: tier.label, variant: tier.variant },
                      ],
                      repositoryUrl: mcp.repositoryUrl ?? mcp.docsUrl,
                      installed: isInstalled(mcp, installed),
                    }}
                    onInstall={() => setSelected(mcp)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>安装 {selected?.name}</DialogTitle>
            <DialogDescription>
              {selected?.oauth?.tier === "B"
                ? "使用整站预注册 OAuth App 授权；未配置时可改用令牌（若支持）。"
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
                router.push("/dashboard/mcp");
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
