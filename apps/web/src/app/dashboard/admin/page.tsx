"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Building2, HardDrive, ShieldAlert, Users } from "lucide-react";
import { api } from "@/lib/api";
import type { AdminStats } from "@/lib/admin";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";

type Platform = {
  setupCompleted: boolean;
  mode: "single-tenant" | "multi-tenant";
  multiTenant?: boolean;
  version: string;
};

type IconComp = React.ComponentType<{ className?: string }>;

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
  tone,
}: {
  icon: IconComp;
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  tone?: "default" | "danger";
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5", tone === "danger" && "text-destructive")} />
        <span>{label}</span>
      </div>
      <div
        className={cn(
          "mt-1.5 font-heading text-2xl font-semibold tabular-nums",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </>
  );

  const className =
    "surface-interactive rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-ring/40";

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** SaaS-only — stripped from OSS builds. */
export default function AdminOverviewPage() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [p, s] = await Promise.all([
          api<Platform>("/api/admin/platform"),
          api<AdminStats>("/api/admin/stats", { cacheTtlMs: false }),
        ]);
        if (cancelled) return;
        setPlatform(p);
        setStats(s);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <PageLoading />
    );
  }

  const suspendedTotal = (stats?.users.suspended ?? 0) + (stats?.tenants.suspended ?? 0);

  return (
    <div className="space-y-5">
      <SettingsHeader title="概览" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Users}
          label="用户"
          value={stats?.users.total ?? 0}
          hint={`近 7 天新增 ${stats?.users.newLast7d ?? 0} · 管理员 ${stats?.users.admins ?? 0}`}
          href="/dashboard/admin/users"
        />
        <StatCard
          icon={Building2}
          label="团队"
          value={stats?.tenants.total ?? 0}
          hint={`近 7 天新增 ${stats?.tenants.newLast7d ?? 0}`}
          href="/dashboard/admin/tenants"
        />
        <StatCard
          icon={HardDrive}
          label="远程 Runner"
          value={stats?.runners.total ?? 0}
          hint={`共享 ${stats?.runners.shared ?? 0} · 在线 ${stats?.runners.online ?? 0}`}
          href="/dashboard/admin/runners"
        />
        <StatCard
          icon={ShieldAlert}
          label="封禁中"
          value={suspendedTotal}
          hint={`用户 ${stats?.users.suspended ?? 0} · 团队 ${stats?.tenants.suspended ?? 0}`}
          href="/dashboard/admin/users?status=suspended"
          tone={suspendedTotal > 0 ? "danger" : "default"}
        />
      </div>

      <SettingsSection
        title="部署模式"
        description="由环境变量控制，不可在此修改"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">{platform?.mode}</Badge>
          <span className="text-xs text-muted-foreground">版本 {platform?.version}</span>
          <span className="text-xs text-muted-foreground">
            初始化{platform?.setupCompleted ? "已完成" : "未完成"}
          </span>
        </div>
      </SettingsSection>
    </div>
  );
}
