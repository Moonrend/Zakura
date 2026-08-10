"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type ZerocatOauthConfig = {
  enabled: boolean;
  ready?: boolean;
  clientId: string;
  hasClientSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  disablePasswordLogin: boolean;
  redirectUri: string;
};

/** SaaS-only — stripped from OSS builds. */
export default function AdminAuthPage() {
  const [oauth, setOauth] = useState<ZerocatOauthConfig | null>(null);
  const [draft, setDraft] = useState({
    enabled: false,
    clientId: "",
    clientSecret: "",
    authorizeUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scope: "",
    allowRegistration: true,
    disablePasswordLogin: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function hydrate(config: ZerocatOauthConfig) {
    setOauth(config);
    setDraft({
      enabled: config.enabled,
      clientId: config.clientId,
      clientSecret: "",
      authorizeUrl: config.authorizeUrl,
      tokenUrl: config.tokenUrl,
      userinfoUrl: config.userinfoUrl,
      scope: config.scope,
      allowRegistration: config.allowRegistration,
      disablePasswordLogin: config.disablePasswordLogin,
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await api<ZerocatOauthConfig>("/api/admin/oauth/zerocat");
        if (!cancelled) hydrate(config);
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

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        clientId: draft.clientId,
        authorizeUrl: draft.authorizeUrl,
        tokenUrl: draft.tokenUrl,
        userinfoUrl: draft.userinfoUrl,
        scope: draft.scope,
        allowRegistration: draft.allowRegistration,
        disablePasswordLogin: draft.disablePasswordLogin,
      };
      // 留空表示保持原 secret
      if (draft.clientSecret.trim()) body.clientSecret = draft.clientSecret.trim();

      const saved = await api<ZerocatOauthConfig>("/api/admin/oauth/zerocat", {
        method: "PUT",
        json: body,
      });
      hydrate(saved);
      toast.success(saved.ready ? "ZeroCat OAuth 已保存并可用" : "已保存（请确认 Client ID / Secret）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="登录与认证"
        description="在 ZeroCat 控制台创建 OAuth 应用，回调地址须与下方 Redirect URI 完全一致。Client Secret 仅存服务端加密存储，不会返回前端。"
      />

      <SettingsSection title="ZeroCat OAuth">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={oauth?.ready ? "default" : "secondary"}>
            {oauth?.ready ? "已启用" : draft.enabled ? "未就绪" : "关闭"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {oauth?.hasClientSecret ? "已配置 Client Secret" : "尚未配置 Client Secret"}
          </span>
        </div>

        <div className="divide-y pt-2">
          <SettingsField label="启用 ZeroCat 登录">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  enabled: v,
                  disablePasswordLogin: v ? d.disablePasswordLogin : false,
                }))
              }
            />
          </SettingsField>
          <SettingsField label="首次登录自动创建团队">
            <Switch
              checked={draft.allowRegistration}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, allowRegistration: v }))}
            />
          </SettingsField>
          <SettingsField label="禁止邮箱密码登录（仅 ZeroCat）">
            <Switch
              checked={draft.disablePasswordLogin}
              disabled={!draft.enabled}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, disablePasswordLogin: v }))}
            />
          </SettingsField>
        </div>
        {draft.disablePasswordLogin ? (
          <p className="text-xs text-muted-foreground">
            开启后登录页只显示 ZeroCat；需 ZeroCat 配置完整可用后才会生效。
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="应用凭据">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="oauth-client-id">Client ID</Label>
            <Input
              id="oauth-client-id"
              value={draft.clientId}
              onChange={(e) => setDraft((d) => ({ ...d, clientId: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-client-secret">
              Client Secret
              {oauth?.hasClientSecret ? (
                <span className="font-normal text-muted-foreground">（留空则保持原值）</span>
              ) : null}
            </Label>
            <Input
              id="oauth-client-secret"
              type="password"
              value={draft.clientSecret}
              onChange={(e) => setDraft((d) => ({ ...d, clientSecret: e.target.value }))}
              autoComplete="new-password"
              placeholder={oauth?.hasClientSecret ? "••••••••" : "粘贴 client_secret"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-redirect">Redirect URI（只读）</Label>
            <Input
              id="oauth-redirect"
              readOnly
              value={oauth?.redirectUri ?? ""}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="端点">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="oauth-scope">Scope</Label>
            <Input
              id="oauth-scope"
              value={draft.scope}
              onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-authorize">Authorize URL</Label>
            <Input
              id="oauth-authorize"
              value={draft.authorizeUrl}
              onChange={(e) => setDraft((d) => ({ ...d, authorizeUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-token">Token URL</Label>
            <Input
              id="oauth-token"
              value={draft.tokenUrl}
              onChange={(e) => setDraft((d) => ({ ...d, tokenUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-userinfo">Userinfo URL</Label>
            <Input
              id="oauth-userinfo"
              value={draft.userinfoUrl}
              onChange={(e) => setDraft((d) => ({ ...d, userinfoUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </SettingsSection>

      <div>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {saving ? "保存中…" : "保存 OAuth 配置"}
        </Button>
      </div>
    </div>
  );
}
