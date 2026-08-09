"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsField, SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export type TransactionalEmailConfig = {
  enabled: boolean;
  fromEmail: string;
  baseUrl: string;
  providerId: string;
  hasApiToken: boolean;
  ready: boolean;
};

type Draft = {
  enabled: boolean;
  fromEmail: string;
  baseUrl: string;
  providerId: string;
  apiToken: string;
};

/**
 * 平台系统发信（Amail），配置落库；SaaS 超管 / OSS 管理员。
 */
export function PlatformTransactionalEmailPanel({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<TransactionalEmailConfig | null>(null);
  const [draft, setDraft] = useState<Draft>({
    enabled: false,
    fromEmail: "",
    baseUrl: "",
    providerId: "",
    apiToken: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const res = await api<TransactionalEmailConfig>("/api/settings/email/transactional");
      setCfg(res);
      setDraft({
        enabled: res.enabled,
        fromEmail: res.fromEmail,
        baseUrl: res.baseUrl,
        providerId: res.providerId,
        apiToken: "",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|平台管理员|Admin|权限/i.test(msg)) {
        setForbidden(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave() {
    setSaving(true);
    try {
      const body: {
        enabled: boolean;
        fromEmail: string;
        baseUrl: string;
        providerId: string;
        apiToken?: string;
      } = {
        enabled: draft.enabled,
        fromEmail: draft.fromEmail.trim(),
        baseUrl: draft.baseUrl.trim(),
        providerId: draft.providerId.trim(),
      };
      if (draft.apiToken.trim()) body.apiToken = draft.apiToken.trim();
      const saved = await api<TransactionalEmailConfig>("/api/settings/email/transactional", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setCfg(saved);
      setDraft((d) => ({
        ...d,
        apiToken: "",
        enabled: saved.enabled,
        fromEmail: saved.fromEmail,
        baseUrl: saved.baseUrl,
        providerId: saved.providerId,
      }));
      toast.success(saved.ready ? "系统发信已保存并可用" : "已保存（请确认发件地址与 API Token）");
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) return null;

  if (loading) {
    return (
      <SettingsSection title="系统发信（Amail）">
        <Skeleton className="h-36 w-full" />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="系统发信（Amail）">
      <p className="mb-4 text-sm text-muted-foreground">
        用于危机支持等平台通知邮件。仅支持 Amail；Token 加密存库，与租户邮箱连接器互不共用。
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant={cfg?.ready ? "default" : "secondary"}>
          {cfg?.ready ? "可用" : "未就绪"}
        </Badge>
        {cfg?.hasApiToken ? (
          <span className="text-xs text-muted-foreground">已配置 API Token</span>
        ) : (
          <span className="text-xs text-muted-foreground">尚未配置 API Token</span>
        )}
      </div>
      <div className="space-y-3">
        <SettingsField label="启用系统发信">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </SettingsField>
        <div className="space-y-1.5">
          <Label htmlFor="tx-email-from">发件地址</Label>
          <Input
            id="tx-email-from"
            type="email"
            placeholder="noreply@example.com"
            value={draft.fromEmail}
            onChange={(e) => setDraft((d) => ({ ...d, fromEmail: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tx-email-token">API Token</Label>
          <Input
            id="tx-email-token"
            type="password"
            autoComplete="new-password"
            placeholder={cfg?.hasApiToken ? "留空则保持原 Token" : "Amail API Token"}
            value={draft.apiToken}
            onChange={(e) => setDraft((d) => ({ ...d, apiToken: e.target.value }))}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tx-email-base">API Base URL（可选）</Label>
            <Input
              id="tx-email-base"
              placeholder="默认即可"
              value={draft.baseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tx-email-provider">Provider ID（可选）</Label>
            <Input
              id="tx-email-provider"
              placeholder="auto"
              value={draft.providerId}
              onChange={(e) => setDraft((d) => ({ ...d, providerId: e.target.value }))}
            />
          </div>
        </div>
        <div className="pt-1">
          <Button type="button" onClick={() => void onSave()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
