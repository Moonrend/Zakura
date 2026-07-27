"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CloudDownload, Server, Store } from "lucide-react";
import { api } from "@/lib/api";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type InstanceRow = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  status: string;
  healthStatus: string;
  lastError?: string | null;
};

const MCP_PROVIDERS = new Set([
  "generic-mcp",
  "stdio-mcp",
  "openviking",
  "google-workspace",
]);

function providerLabel(id: string) {
  switch (id) {
    case "generic-mcp":
      return "HTTP";
    case "stdio-mcp":
      return "Stdio";
    case "openviking":
      return "OpenViking";
    case "google-workspace":
      return "Google Workspace";
    default:
      return id;
  }
}

function needsUpstreamAuth(i: InstanceRow): boolean {
  return (
    !!i.lastError?.startsWith("AUTH_REQUIRED") ||
    /missing required Authorization|401|unauthorized/i.test(i.lastError ?? "")
  );
}

/** 远程 HTTP MCP 无本地进程；status 表示平台侧启用，非容器生命周期 */
function isRemoteMcp(providerId: string) {
  return providerId === "generic-mcp" || providerId === "google-workspace";
}

function statusVariant(
  status: string,
  healthStatus?: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running" && healthStatus === "unhealthy") return "danger";
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
}

function statusLabel(i: InstanceRow): string {
  if (isRemoteMcp(i.providerId)) {
    if (i.status === "running") {
      if (i.healthStatus === "unhealthy") return "不可用";
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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const inst = await api<InstanceRow[]>("/api/instances", { cacheTtlMs: false });
      setInstances(inst.filter((i) => MCP_PROVIDERS.has(i.providerId)));
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
      <SettingsHeader title="服务器" />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 服务器</p>
          <div className="flex flex-wrap justify-center gap-2">
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
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {instances.map((i) => {
            const authNeeded = needsUpstreamAuth(i);
            const errorText = formatError(i.lastError);

            return (
              <Link
                key={i.id}
                href={`/dashboard/mcp/${i.id}`}
                className={cn(
                  "group flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
                  "transition-colors hover:border-foreground/20 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex items-start gap-2.5">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Server className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium group-hover:underline underline-offset-2">
                          {i.name}
                        </span>
                        {authNeeded ? (
                          <Badge variant="destructive" className="text-[10px]">
                            需 OAuth
                          </Badge>
                        ) : null}
                      </div>
                      <code className="block truncate text-[10px] text-muted-foreground">
                        {i.slug}
                      </code>
                    </div>
                  </div>
                  <Badge
                    variant={statusVariant(i.status, i.healthStatus)}
                    className="shrink-0"
                    title={
                      isRemoteMcp(i.providerId)
                        ? "远程 MCP 无本地进程；此状态表示是否已在平台启用"
                        : undefined
                    }
                  >
                    {statusLabel(i)}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px]">
                    {providerLabel(i.providerId)}
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
    </div>
  );
}
