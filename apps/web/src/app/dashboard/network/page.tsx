"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Network, RefreshCw, Shield } from "lucide-react";
import {
  fetchNetworkOverview,
  networkPath,
  testProvider,
  type NetworkOverviewDto,
} from "@/lib/network";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function NetworkOverviewPage() {
  const [data, setData] = useState<NetworkOverviewDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchNetworkOverview());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function testDefaultTunnel() {
    if (!data?.defaultProvider) {
      toast.error("未配置默认 Provider");
      return;
    }
    setBusy(true);
    try {
      const res = await testProvider(data.defaultProvider);
      if (res.ok) {
        toast.success(res.publicUrl ? `就绪：${res.publicUrl}` : res.message);
      } else {
        toast.error(res.message);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="网络与隧道" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="网络与隧道"
        actions={
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Badge variant={data.mesh.connected ? "default" : "secondary"}>
          Runner 组网: Tailscale · {data.mesh.connected ? "已连接" : "未连接"}
        </Badge>
        <Badge variant={data.exposureEnabled ? "default" : "secondary"}>
          端口暴露: {data.defaultProvider ?? "—"} ·{" "}
          {data.exposureEnabled ? "已启用" : "已禁用"}
        </Badge>
      </div>

      {data.hostJoinsTailscale === false ? (
        <p className="text-xs text-muted-foreground">控制面不加入团队 Tailnet</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <SettingsSection>
          <div className="text-2xl font-semibold tabular-nums">
            {data.runners.online}/{data.runners.total}
          </div>
          <div className="text-xs text-muted-foreground">Runners 在线</div>
        </SettingsSection>
        <SettingsSection>
          <div className="text-2xl font-semibold tabular-nums">{data.activeExposures}</div>
          <div className="text-xs text-muted-foreground">活跃隧道</div>
        </SettingsSection>
        <SettingsSection>
          <div className="text-2xl font-semibold tabular-nums">{data.exposuresToday}</div>
          <div className="text-xs text-muted-foreground">
            今日暴露 · 审计 {data.auditEventsToday}
          </div>
        </SettingsSection>
      </div>

      <SettingsSection title="快捷操作">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={networkPath("mesh")} />}>
            <Network className="size-3.5" />
            管理组网
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void testDefaultTunnel()}>
            测试默认隧道
          </Button>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={networkPath("security")} />}>
            <Shield className="size-3.5" />
            安全策略
          </Button>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={networkPath("active")} />}>
            查看活跃暴露
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
