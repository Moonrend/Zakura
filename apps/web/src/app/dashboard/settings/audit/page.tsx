"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/progress-linear";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

type Item = {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  targetType: string | null;
  ip: string | null;
  createdAt: string;
};

export default function AuditSettingsPage() {
  const me = useMe();
  const admin = me.role === "owner" || me.role === "admin" || me.isPlatformAdmin;
  const [items, setItems] = useState<Item[]>([]);
  const [action, setAction] = useState("");
  const [retentionDays, setRetentionDays] = useState(365);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await api<{ items: Item[]; retentionDays: number }>(
      `/api/tenant/audit?limit=80${action ? `&action=${encodeURIComponent(action)}` : ""}`,
    );
    setItems(res.items);
    setRetentionDays(res.retentionDays);
    setLoading(false);
  }, [action]);

  useEffect(() => {
    if (!admin) return;
    void load().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [admin, load]);

  if (!admin) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="合规审计" description="仅管理员可查看。" />
      </div>
    );
  }
  if (loading) return <PageLoading />;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="合规审计"
        description="登录、成员、SSO、SCIM 与域名变更记录"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const { getSession } = await import("@/lib/api");
              const res = await fetch(`/api/tenant/audit?format=csv${action ? `&action=${encodeURIComponent(action)}` : ""}`, {
                headers: { Authorization: `Bearer ${getSession() ?? ""}` },
              });
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "audit.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            导出 CSV
          </Button>
        }
      />
      <SettingsSection title="筛选">
        <div className="flex flex-wrap gap-2">
          <Input placeholder="action，如 auth.login" value={action} onChange={(e) => setAction(e.target.value)} />
          <Button size="sm" onClick={() => void load()}>查询</Button>
          <Input
            className="w-24"
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
          />
          <Button size="sm" variant="outline" onClick={async () => {
            const res = await api<{ retentionDays: number }>("/api/tenant/audit/retention", {
              method: "PUT",
              json: { retentionDays },
            });
            setRetentionDays(res.retentionDays);
            toast.success("已保存保留天数");
          }}>保存保留</Button>
        </div>
      </SettingsSection>
      <SettingsSection title="最近事件">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-xs">{new Date(row.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-xs">{row.action}</TableCell>
                <TableCell className="text-xs">{row.actorType}{row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ""}</TableCell>
                <TableCell className="text-xs">{row.ip ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SettingsSection>
    </div>
  );
}
