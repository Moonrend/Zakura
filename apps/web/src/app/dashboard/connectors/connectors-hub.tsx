"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import {
  ConnectorConfigSheet,
  type ConnectorView,
} from "@/components/connections/connector-config-sheet";
import { SettingsHeader } from "@/components/settings-shell";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

type IntegrationPackage = {
  slug: string;
  name: string;
  description: string;
  icon?: string | null;
  accent?: string | null;
  category?: string | null;
  homepage?: string | null;
  verified?: boolean;
  featured?: boolean;
  componentCounts?: Record<string, number>;
  components: Array<{
    kind: string;
    ref: string;
    name: string;
    installed?: boolean;
  }>;
};

type ConnectorRow = ConnectorView;

type ViewMode = "all" | "configured" | "unconfigured";

function isConfigured(connector: ConnectorRow | undefined) {
  return connector?.status === "ready" || connector?.status === "platform-provisioned";
}

function statusLabel(connector: ConnectorRow | undefined) {
  if (connector?.status === "platform-provisioned") return "整站预配";
  if (connector?.status === "ready") return "已配置";
  if (connector?.status === "disabled") return "已停用";
  return "待配置";
}

/** 连接器中心列表 */
export default function ConnectorsHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [packages, setPackages] = useState<IntegrationPackage[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [view, setView] = useState<ViewMode>("all");
  const [redirectUri, setRedirectUri] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pkgs, creds] = await Promise.all([
        api<{ packages: IntegrationPackage[] }>("/api/integrations/packages"),
        api<{ connectors: ConnectorRow[]; redirectUri?: string }>("/api/connectors?scope=tenant"),
      ]);
      setPackages(pkgs.packages);
      setConnectors(creds.connectors);
      setRedirectUri(creds.redirectUri ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const bySlug = useMemo(() => {
    const map = new Map<string, ConnectorRow[]>();
    for (const c of connectors) {
      const current = map.get(c.package.slug) ?? [];
      current.push(c);
      map.set(c.package.slug, current);
    }
    return map;
  }, [connectors]);

  const filtered = useMemo(() => {
    const value = q.trim().toLowerCase();
    const searched = value
      ? packages.filter((pkg) =>
          [pkg.name, pkg.description, pkg.category, pkg.slug]
            .filter(Boolean)
            .some((t) => String(t).toLowerCase().includes(value)),
        )
      : packages;
    return searched.filter((pkg) => {
      if (pkg.slug === "agent-remote") return false;
      const packageConnectors = bySlug.get(pkg.slug) ?? [];
      return (
        view === "all" ||
        (view === "configured"
          ? packageConnectors.some((connector) => isConfigured(connector))
          : !packageConnectors.some((connector) => isConfigured(connector)))
      );
    });
  }, [packages, q, view, bySlug]);

  const selectedSlug = searchParams.get("connector");
  const selected = selectedSlug ? bySlug.get(selectedSlug) ?? [] : [];

  useEffect(() => {
    if (selectedSlug === "agent-remote") router.replace("/dashboard/agents");
  }, [router, selectedSlug]);

  function openConnector(slug: string) {
    if (slug === "agent-remote") {
      router.push("/dashboard/agents");
      return;
    }
    router.push(`/dashboard/connectors?connector=${encodeURIComponent(slug)}`, { scroll: false });
  }

  function closeConnector(open: boolean) {
    if (!open) router.push("/dashboard/connectors", { scroll: false });
  }

  const counts = useMemo(() => {
    const visible = packages.filter((pkg) => pkg.slug !== "agent-remote");
    const configured = visible.filter((pkg) =>
      (bySlug.get(pkg.slug) ?? []).some((connector) => isConfigured(connector)),
    ).length;
    return {
      all: visible.length,
      configured,
      unconfigured: visible.length - configured,
    };
  }, [packages, bySlug]);

  /* Keep package metadata in the list and the complete connector view in the sheet. */
  const visiblePackages = filtered;

  return (
    <div className="space-y-6">
      <SettingsHeader title="平台连接器" />

      <p className="text-xs text-muted-foreground">
        厂商托管 MCP 见{" "}
        <Link href="/dashboard/mcp/store" className="text-foreground underline-offset-4 hover:underline">
          MCP 商店
        </Link>
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 border-b border-border">
          {(["all", "configured", "unconfigured"] as const).map((key) => {
            const label = key === "all" ? "全部" : key === "configured" ? "已配置" : "未配置";
            return (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={`border-b-2 px-3 py-2 text-xs transition-colors ${
                  view === key
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}{" "}
                <span className="text-[10px] text-muted-foreground">{counts[key]}</span>
              </button>
            );
          })}
        </div>
        <SearchField value={q} onValueChange={setQ} placeholder="搜索连接器" />
      </div>

      <div className="divide-y divide-border border-y border-border">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-none" />
            ))
          : visiblePackages.map((pkg) => {
              const packageConnectors = bySlug.get(pkg.slug) ?? [];
              const connector = packageConnectors.find((item) => item.ready) ?? packageConnectors[0];
              const toolCount = pkg.componentCounts?.tool ?? 0;
              const skillCount = pkg.componentCounts?.skill ?? 0;
              const installedTools = packageConnectors.flatMap((item) => item.capabilities).filter(
                (capability) => capability.kind === "tool" && capability.installed,
              ).length;
              return (
                <button
                  key={pkg.slug}
                  type="button"
                  onClick={() => openConnector(pkg.slug)}
                  className="group flex w-full items-center gap-3 rounded-lg px-1 py-4 text-left surface-interactive sm:px-2"
                >
                  <BrandIcon
                    brandId={pkg.slug}
                    name={pkg.name}
                    accent={pkg.accent}
                    homepage={pkg.homepage}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-medium">{pkg.name}</h2>
                      {pkg.verified ? (
                        <span className="text-[10px] text-muted-foreground">已验证</span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {pkg.description}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                    <div>{statusLabel(connector)}</div>
                    <div className="mt-1">
                      {[toolCount ? `${toolCount} 功能` : null, skillCount ? `${skillCount} 技能` : null, installedTools ? `${installedTools} 已装` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <span className="shrink-0 text-muted-foreground transition-opacity duration-150 group-hover:text-foreground">→</span>
                </button>
              );
            })}
      </div>

      {!loading && !visiblePackages.length ? (
        <p className="border-y border-border py-12 text-center text-sm text-muted-foreground">
          没有匹配的连接器
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          加载中…
        </div>
      ) : null}

      <ConnectorConfigSheet
        connectors={selected}
        redirectUri={redirectUri}
        open={selected.length > 0}
        onOpenChange={closeConnector}
        onChanged={() => void load()}
      />
    </div>
  );
}
