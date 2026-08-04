"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CloudDownload, Store } from "lucide-react";
import { api } from "@/lib/api";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NoSearchResult, SearchField } from "@/components/ui/search-field";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { cn } from "@/lib/utils";

type InstanceRow = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  provider?: { name?: string | null; category?: string | null } | null;
  status: string;
  healthStatus: string;
  lastError?: string | null;
};

function providerLabel(instance: InstanceRow) {
  return instance.provider?.name || instance.providerId;
}

/** 远程 HTTP MCP 无本地进程；status 表示平台侧启用，非容器生命周期 */
function isRemoteMcp(instance: InstanceRow) {
  return (
    instance.provider?.category === "mcp" &&
    instance.providerId !== "stdio-mcp"
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
}

function statusLabel(i: InstanceRow): string {
  if (isRemoteMcp(i)) {
    if (i.status === "running") {
      return "已启用";
    }
    if (i.status === "starting") return "启用中";
    if (i.status === "stopping") return "停用中";
    return "未启用";
  }
  if (i.status === "running") return "运行中";
  if (i.status === "starting") return "启动中";
  if (i.status === "stopping") return "停止中";
  if (i.status === "stopped") return "已停止";
  return i.status;
}

function formatError(err: string | null | undefined): string | null {
  if (!err) return null;
  return err.replace(/^(AUTH_REQUIRED|UNREACHABLE):\s*/, "");
}

export default function McpServersPage() {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const filtered = useFuzzySearch(instances, q, {
    keys: [
      { name: "name", weight: 3 },
      { name: "slug", weight: 2 },
      { name: "providerId", weight: 1 },
    ],
  });

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const inst = await api<InstanceRow[]>("/api/instances", { cacheTtlMs: false });
      setInstances(
        inst.filter(
          (i) => i.provider?.category === "mcp",
        ),
      );
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 实例状态变化经平台事件推送：已知实例就地更新，新实例静默重拉
  useEffect(() => {
    return subscribePlatformEvents(
      (ev) => {
        if (ev.type !== "mcp_instance") return;
        setInstances((prev) => {
          if (!prev.some((i) => i.id === ev.instanceId)) {
            void load(true);
            return prev;
          }
          return prev.map((i) =>
            i.id === ev.instanceId ? { ...i, status: ev.status } : i,
          );
        });
      },
      () => void load(true),
    );
  }, [load]);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="MCP"
        description="管理已安装的服务器，从官方或社区商店添加"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" nativeButton={false} render={<Link href="/dashboard/mcp/official" />}>
              <Store />
              官方商店
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/store" />}
            >
              社区商店
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/mcp/import" />}
            >
              <CloudDownload />
              导入
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-1 text-sm text-muted-foreground">暂无 MCP 服务器</p>
          <p className="text-xs text-muted-foreground">从上方商店安装，或导入已有配置</p>
        </div>
      ) : (
        <>
          {instances.length > 4 ? (
            <SearchField
              value={q}
              onValueChange={setQ}
              placeholder="搜索 MCP 服务器"
              className="max-w-sm"
            />
          ) : null}
          {filtered.length === 0 ? (
            <NoSearchResult query={q} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((i) => {
            const errorText = formatError(i.lastError);

            return (
              <Link
                key={i.id}
                href={`/dashboard/mcp/${i.id}`}
                className={cn(
                  "group flex flex-col gap-2 rounded-lg border border-border bg-card p-4",
                  "transition-colors hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium group-hover:underline underline-offset-2">
                        {i.name}
                      </span>
                    </div>
                    <code className="block truncate text-[10px] text-muted-foreground">
                      {i.slug}
                    </code>
                  </div>
                  <Badge
                    variant={statusVariant(i.status)}
                    className="shrink-0"
                    title={
                      isRemoteMcp(i)
                        ? "远程 MCP 无本地进程；此状态表示是否已在平台启用"
                        : undefined
                    }
                  >
                    {statusLabel(i)}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {providerLabel(i)}
                  </Badge>
                </div>

                {errorText ? (
                  <p
                    className="line-clamp-2 text-[11px] text-muted-foreground"
                    title={i.lastError ?? undefined}
                  >
                    {errorText}
                  </p>
                ) : null}
              </Link>
            );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
