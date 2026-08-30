"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  fetchAuditLogs,
  fetchSecurityPolicy,
  updateSecurityPolicy,
  type NetworkAuditLogDto,
  type NetworkSecurityPolicyDto,
} from "@/lib/network";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export default function NetworkSecurityPage() {
  const [policy, setPolicy] = useState<NetworkSecurityPolicyDto | null>(null);
  const [deniedPorts, setDeniedPorts] = useState("");
  const [audit, setAudit] = useState<NetworkAuditLogDto[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        fetchSecurityPolicy(),
        fetchAuditLogs({ limit: 30 }),
      ]);
      setPolicy(p.policy);
      setDeniedPorts(p.policy.deniedPorts.join(", "));
      setAudit(a.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<NetworkSecurityPolicyDto>) {
    if (!policy) return;
    setBusy(true);
    try {
      const res = await updateSecurityPolicy({ ...policy, ...patch });
      setPolicy(res.policy);
      setDeniedPorts(res.policy.deniedPorts.join(", "));
      toast.success("已保存");
      const a = await fetchAuditLogs({ limit: 30 });
      setAudit(a.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!policy) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="安全策略" />
        <PageLoading />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="安全策略"
        actions={
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              const ports = deniedPorts
                .split(/[,\s]+/)
                .map((x) => Number(x.trim()))
                .filter((n) => Number.isInteger(n) && n > 0);
              void save({
                deniedPorts: ports,
                defaultTtlMinutes: policy.defaultTtlMinutes,
                maxTtlMinutes: policy.maxTtlMinutes,
                maxActivePerAgent: policy.maxActivePerAgent,
                maxActivePerTenant: policy.maxActivePerTenant,
                auditRetentionDays: policy.auditRetentionDays,
              });
            }}
          >
            保存
          </Button>
        }
      />

      <SettingsSection title="端口暴露">
        <SettingsField label="总开关">
          <Switch
            checked={policy.exposureEnabled}
            disabled={busy}
            onCheckedChange={(v) => void save({ exposureEnabled: Boolean(v) })}
          />
        </SettingsField>
        <SettingsField label="允许公网暴露">
          <Switch
            checked={policy.allowPublicExposure}
            disabled={busy}
            onCheckedChange={(v) => void save({ allowPublicExposure: Boolean(v) })}
          />
        </SettingsField>
        <SettingsField label="允许 TCP 暴露">
          <Switch
            checked={policy.allowTcpExposure}
            disabled={busy}
            onCheckedChange={(v) => void save({ allowTcpExposure: Boolean(v) })}
          />
        </SettingsField>
        <SettingsField label="允许桌面/CDP 端口">
          <Switch
            checked={policy.allowDesktopExposure}
            disabled={busy}
            onCheckedChange={(v) => void save({ allowDesktopExposure: Boolean(v) })}
          />
        </SettingsField>
        <SettingsField label="默认 TTL（分钟）">
          <Input
            className="w-24"
            type="number"
            value={policy.defaultTtlMinutes}
            onChange={(e) =>
              setPolicy({ ...policy, defaultTtlMinutes: Number(e.target.value) || 1 })
            }
          />
        </SettingsField>
        <SettingsField label="最大 TTL（分钟）">
          <Input
            className="w-24"
            type="number"
            value={policy.maxTtlMinutes}
            onChange={(e) =>
              setPolicy({ ...policy, maxTtlMinutes: Number(e.target.value) || 1 })
            }
          />
        </SettingsField>
        <SettingsField label="每 Agent 最大并发">
          <Input
            className="w-24"
            type="number"
            value={policy.maxActivePerAgent}
            onChange={(e) =>
              setPolicy({ ...policy, maxActivePerAgent: Number(e.target.value) || 0 })
            }
          />
        </SettingsField>
        <SettingsField label="团队最大并发">
          <Input
            className="w-24"
            type="number"
            value={policy.maxActivePerTenant}
            onChange={(e) =>
              setPolicy({ ...policy, maxActivePerTenant: Number(e.target.value) || 0 })
            }
          />
        </SettingsField>
        <div className="space-y-1 py-1">
          <div className="text-sm">拒绝端口（逗号分隔）</div>
          <Input
            className="font-mono text-xs"
            value={deniedPorts}
            onChange={(e) => setDeniedPorts(e.target.value)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Agent / 组网">
        <SettingsField label="允许 Agent MCP 自助暴露">
          <Switch
            checked={policy.agentsCanExpose}
            disabled={busy}
            onCheckedChange={(v) => void save({ agentsCanExpose: Boolean(v) })}
          />
        </SettingsField>
        <SettingsField label="远程 Runner 必须 Tailscale">
          <Switch
            checked={policy.requireTailscaleForRemoteRunners}
            disabled={busy}
            onCheckedChange={(v) =>
              void save({ requireTailscaleForRemoteRunners: Boolean(v) })
            }
          />
        </SettingsField>
        <SettingsField label="审计保留天数">
          <Input
            className="w-24"
            type="number"
            value={policy.auditRetentionDays}
            onChange={(e) =>
              setPolicy({ ...policy, auditRetentionDays: Number(e.target.value) || 1 })
            }
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="最近审计">
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无事件</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>主体</TableHead>
                <TableHead>目标</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.action}</TableCell>
                  <TableCell className="text-xs">
                    {row.actorType}
                    {row.actorId ? `:${row.actorId.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.targetType ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </div>
  );
}
