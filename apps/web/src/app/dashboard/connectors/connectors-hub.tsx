"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
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

type ConnectorRow = {
  id: string;
  ref: string;
  name: string;
  ready: boolean;
  enabled: boolean;
  lockedByPlatform?: boolean;
  credentialSource?: "tenant" | "platform" | null;
  package: { slug: string; name: string; icon?: string | null; accent?: string | null };
};

/** 连接器中心列表 */
export default function ConnectorsHub() {
  const [packages, setPackages] = useState<IntegrationPackage[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pkgs, creds] = await Promise.all([
        api<{ packages: IntegrationPackage[] }>("/api/integrations/packages"),
        api<{ connectors: ConnectorRow[] }>("/api/connectors?scope=tenant"),
      ]);
      setPackages(pkgs.packages);
      setConnectors(creds.connectors);
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
    const map = new Map<string, ConnectorRow>();
    for (const c of connectors) map.set(c.package.slug, c);
    return map;
  }, [connectors]);

  const filtered = useMemo(() => {
    const value = q.trim().toLowerCase();
    if (!value) return packages;
    return packages.filter((pkg) =>
      [pkg.name, pkg.description, pkg.category, pkg.slug]
        .filter(Boolean)
        .some((t) => String(t).toLowerCase().includes(value)),
    );
  }, [packages, q]);

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="平台连接器"
        description="平台直连第三方 REST / GraphQL API。在详情页配置 OAuth，再安装工具并授权。"
      />

      <p className="text-xs text-muted-foreground">
        厂商托管 MCP 端点请去{" "}
        <Link href="/dashboard/mcp/store" className="text-foreground hover:underline">
          MCP 商店
        </Link>
        ；OAuth 客户端记录见{" "}
        <Link
          href="/dashboard/settings/oauth-clients"
          className="text-foreground hover:underline"
        >
          设置
        </Link>
        。
      </p>

      <SearchField value={q} onValueChange={setQ} placeholder="搜索连接器" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-lg" />
            ))
          : filtered.map((pkg) => {
              const connector = bySlug.get(pkg.slug);
              const toolCount = pkg.componentCounts?.tool ?? 0;
              const skillCount = pkg.componentCounts?.skill ?? 0;
              const installedTools = pkg.components.filter(
                (c) => c.kind === "tool" && c.installed,
              ).length;
              const locked = !!connector?.lockedByPlatform;
              const ready = !!connector?.ready;
              return (
                <Link
                  key={pkg.slug}
                  href={`/dashboard/connectors/${encodeURIComponent(pkg.slug)}`}
                  className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-start gap-3">
                    <BrandIcon
                      brandId={pkg.slug}
                      name={pkg.name}
                      accent={pkg.accent}
                      homepage={pkg.homepage}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h2 className="truncate text-sm font-medium">{pkg.name}</h2>
                        {pkg.verified ? (
                          <Badge variant="secondary" className="text-[10px]">
                            官方
                          </Badge>
                        ) : null}
                        {locked ? (
                          <Badge variant="outline" className="text-[10px]">
                            已预配
                          </Badge>
                        ) : ready ? (
                          <Badge variant="secondary" className="text-[10px]">
                            已配置
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            待配置
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {pkg.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 text-[11px] text-muted-foreground">
                    <span>
                      {[
                        toolCount ? `${toolCount} 工具` : null,
                        skillCount ? `${skillCount} 技能` : null,
                        installedTools ? `${installedTools} 已装` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "打开配置"}
                    </span>
                  </div>
                </Link>
              );
            })}
      </div>

      {!loading && !filtered.length ? (
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
    </div>
  );
}
