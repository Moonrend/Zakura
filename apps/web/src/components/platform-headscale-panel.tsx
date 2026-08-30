"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  fetchPlatformHeadscale,
  savePlatformHeadscale,
  type PlatformHeadscaleConfig,
} from "@/lib/network";
import { SettingsField, SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import { Switch } from "@/components/ui/switch";

type Draft = {
  enabled: boolean;
  url: string;
  apiKey: string;
  platformAuthKey: string;
};

/**
 * Platform Headscale credentials (DB-backed).
 * SaaS 超管专用；OSS 不支持 Headscale。
 */
export function PlatformHeadscalePanel({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<PlatformHeadscaleConfig | null>(null);
  const [draft, setDraft] = useState<Draft>({
    enabled: false,
    url: "",
    apiKey: "",
    platformAuthKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const res = await fetchPlatformHeadscale();
      setCfg(res);
      setDraft({
        enabled: res.enabled,
        url: res.url,
        apiKey: "",
        platformAuthKey: "",
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
        url: string;
        apiKey?: string;
        platformAuthKey?: string;
      } = {
        enabled: draft.enabled,
        url: draft.url.trim(),
      };
      if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
      if (draft.platformAuthKey.trim()) {
        body.platformAuthKey = draft.platformAuthKey.trim();
      }
      const saved = await savePlatformHeadscale(body);
      setCfg(saved);
      setDraft((d) => ({ ...d, apiKey: "", platformAuthKey: "", enabled: saved.enabled }));
      toast.success(saved.ready ? "Headscale 已保存并可用" : "已保存（请确认 URL / API Key）");
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
      <SettingsSection title="平台 Headscale">
        <PageLoading />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="平台 Headscale">
      <p className="text-sm text-muted-foreground">SaaS 团队托管组网</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant={cfg?.ready ? "default" : "secondary"}>
          {cfg?.ready ? "已就绪" : draft.enabled ? "未就绪" : "关闭"}
        </Badge>
        {cfg?.hasApiKey ? (
          <span className="text-xs text-muted-foreground">已配置 API Key</span>
        ) : (
          <span className="text-xs text-muted-foreground">尚未配置 API Key</span>
        )}
        {cfg?.hasPlatformAuthKey ? (
          <span className="text-xs text-muted-foreground">已配置平台 PreAuth Key</span>
        ) : null}
      </div>

      <div className="mt-4 space-y-4">
        <SettingsField label="启用平台托管网络">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </SettingsField>
        <div className="space-y-1.5">
          <Label htmlFor="hs-url">Headscale URL</Label>
          <Input
            id="hs-url"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            placeholder="https://headscale.example.com"
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hs-api-key">
            API Key
            {cfg?.hasApiKey ? (
              <span className="font-normal text-muted-foreground">（留空则保持原值）</span>
            ) : null}
          </Label>
          <Input
            id="hs-api-key"
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
            autoComplete="new-password"
            placeholder={cfg?.hasApiKey ? "••••••••" : "headscale apikeys create"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hs-platform-key">
            平台 PreAuth Key（可选）
            {cfg?.hasPlatformAuthKey ? (
              <span className="font-normal text-muted-foreground">（留空则保持原值）</span>
            ) : null}
          </Label>
          <Input
            id="hs-platform-key"
            type="password"
            value={draft.platformAuthKey}
            onChange={(e) => setDraft((d) => ({ ...d, platformAuthKey: e.target.value }))}
            autoComplete="new-password"
            placeholder={
              cfg?.hasPlatformAuthKey ? "••••••••" : "不填则首次启用时自动签发"
            }
          />
        </div>
        <Button type="button" onClick={() => void onSave()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {saving ? "保存中…" : "保存 Headscale 配置"}
        </Button>
      </div>
    </SettingsSection>
  );
}
