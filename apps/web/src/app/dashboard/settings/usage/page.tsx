"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { fetchTenantUsage } from "@/lib/user-usage";
import type { UserUsageTenantRowDto } from "@zakura/shared";
import { useMe } from "@/components/me-context";
import { UserUsagePanel } from "@/components/usage/user-usage-panel";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function TenantUsagePage() {
  const me = useMe();
  const router = useRouter();
  const saas = me.edition === "saas" || me.multiTenant === true;
  const isAdmin = me.role === "owner" || me.role === "admin" || me.isPlatformAdmin;
  const [rows, setRows] = useState<UserUsageTenantRowDto[] | null>(null);

  useEffect(() => {
    if (!saas) router.replace("/dashboard/settings/team");
  }, [saas, router]);

  useEffect(() => {
    if (!saas || !isAdmin) return;
    void fetchTenantUsage(30)
      .then((r) => setRows(r.users))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [isAdmin]);

  if (!saas) return null;

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <SettingsHeader title="我的用量" description="近 30 天" />
        <UserUsagePanel scope="me" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="成员用量"
        description="近 30 天成员用量"
      />

      <SettingsSection title="团队成员">
        {!rows ? (
          <PageLoading />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>最近活跃</TableHead>
                <TableHead>登录</TableHead>
                <TableHead>会话</TableHead>
                <TableHead>回合</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow key={u.userId}>
                  <TableCell>
                    <Link
                      href={`/dashboard/settings/usage/${u.userId}`}
                      className="font-medium hover:underline"
                    >
                      {u.name || u.email}
                    </Link>
                    <div className="font-mono text-[11px] text-muted-foreground">{u.userId}</div>
                  </TableCell>
                  <TableCell
                    className="text-xs text-muted-foreground"
                    title={u.lastSeenAt ? formatAbsolute(u.lastSeenAt) : undefined}
                  >
                    {u.lastSeenAt ? formatRelative(u.lastSeenAt) : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">{u.logins}</TableCell>
                  <TableCell className="tabular-nums text-xs">{u.sessionsStarted}</TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {u.runsOk + u.runsError}
                    {u.runsError ? (
                      <span className="text-muted-foreground"> · {u.runsError} 失败</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    当前团队还没有成员
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </div>
  );
}
