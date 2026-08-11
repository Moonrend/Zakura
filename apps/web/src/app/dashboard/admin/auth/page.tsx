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

type ProviderConfig = {
  id: string;
  name: string;
  enabled: boolean;
  ready: boolean;
  clientId: string;
  hasClientSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
  redirectUri: string;
};

type ProvidersResponse = {
  providers: ProviderConfig[];
  disablePasswordLogin: boolean;
  passwordLoginEnabled: boolean;
  anyOauthReady: boolean;
  highlightedMethod: string;
  highlightedMethodEffective?: string;
};

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  allowRegistration: boolean;
};

function emptyDraft(): Draft {
  return {
    enabled: false,
    clientId: "",
    clientSecret: "",
    authorizeUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scope: "",
    allowRegistration: true,
  };
}

function draftFrom(config: ProviderConfig): Draft {
  return {
    enabled: config.enabled,
    clientId: config.clientId,
    clientSecret: "",
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    userinfoUrl: config.userinfoUrl,
    scope: config.scope,
    allowRegistration: config.allowRegistration,
  };
}

/** SaaS-only — stripped from OSS builds. */
export default function AdminAuthPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [disablePasswordLogin, setDisablePasswordLogin] = useState(false);
  const [highlightedMethod, setHighlightedMethod] = useState("auto");
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [anyOauthReady, setAnyOauthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const selected = providers.find((p) => p.id === selectedId) ?? null;

  function applyList(res: ProvidersResponse, preferId?: string | null) {
    setProviders(res.providers);
    setDisablePasswordLogin(res.disablePasswordLogin);
    setHighlightedMethod(res.highlightedMethod || "auto");
    setPasswordLoginEnabled(res.passwordLoginEnabled !== false);
    setAnyOauthReady(res.anyOauthReady);
    const nextId =
      (preferId && res.providers.some((p) => p.id === preferId) && preferId) ||
      selectedId ||
      res.providers[0]?.id ||
      null;
    setSelectedId(nextId);
    const cfg = res.providers.find((p) => p.id === nextId);
    setDraft(cfg ? draftFrom(cfg) : emptyDraft());
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<ProvidersResponse>("/api/admin/oauth/providers");
        if (!cancelled) applyList(res);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  function selectProvider(id: string) {
    const cfg = providers.find((p) => p.id === id);
    setSelectedId(id);
    setDraft(cfg ? draftFrom(cfg) : emptyDraft());
  }

  async function saveProvider() {
    if (!selectedId) return;
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
      };
      if (draft.clientSecret.trim()) body.clientSecret = draft.clientSecret.trim();

      await api(`/api/admin/oauth/${selectedId}`, { method: "PUT", json: body });
      const res = await api<ProvidersResponse>("/api/admin/oauth/providers");
      applyList(res, selectedId);
      const saved = res.providers.find((p) => p.id === selectedId);
      toast.success(
        saved?.ready ? `${saved.name} 已保存并可用` : "已保存（请确认 Client ID / Secret）",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function savePolicy(patch: {
    disablePasswordLogin?: boolean;
    highlightedMethod?: string;
  }) {
    setSavingPolicy(true);
    try {
      const res = await api<{
        disablePasswordLogin: boolean;
        passwordLoginEnabled: boolean;
        anyOauthReady: boolean;
        highlightedMethod: string;
      }>("/api/admin/oauth/login-policy", {
        method: "PUT",
        json: patch,
      });
      setDisablePasswordLogin(res.disablePasswordLogin);
      setPasswordLoginEnabled(res.passwordLoginEnabled !== false);
      setAnyOauthReady(res.anyOauthReady);
      setHighlightedMethod(res.highlightedMethod || "auto");
      toast.success("登录策略已更新");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPolicy(false);
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
        description="配置多个 OAuth 登录提供商。相同邮箱会自动合并到同一账号。Client Secret 仅存服务端加密存储，不会返回前端。"
      />

      <SettingsSection title="登录策略">
        <div className="divide-y">
          <SettingsField label="禁止邮箱密码登录（仅 OAuth）">
            <Switch
              checked={disablePasswordLogin}
              disabled={savingPolicy || (!anyOauthReady && !disablePasswordLogin)}
              onCheckedChange={(v) => void savePolicy({ disablePasswordLogin: v })}
            />
          </SettingsField>
          <SettingsField label="高亮登录方式">
            <select
              className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm"
              value={highlightedMethod}
              disabled={savingPolicy}
              onChange={(e) => void savePolicy({ highlightedMethod: e.target.value })}
            >
              <option value="auto">自动（默认）</option>
              {passwordLoginEnabled ? <option value="password">邮箱密码</option> : null}
              {providers
                .filter((p) => p.ready)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </SettingsField>
        </div>
        <p className="text-xs text-muted-foreground">
          高亮项在登录页使用主按钮样式并排在前面；若所选方式不可用会回退为自动。
        </p>
      </SettingsSection>

      <SettingsSection title="OAuth 提供商">
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={selectedId === p.id ? "default" : "outline"}
              onClick={() => selectProvider(p.id)}
            >
              {p.name}
              <Badge
                variant={p.ready ? "default" : "secondary"}
                className="ml-1.5"
              >
                {p.ready ? "可用" : p.enabled ? "未就绪" : "关"}
              </Badge>
            </Button>
          ))}
        </div>
      </SettingsSection>

      {selected ? (
        <>
          <SettingsSection title={`${selected.name} 开关`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={selected.ready ? "default" : "secondary"}>
                {selected.ready ? "已启用" : draft.enabled ? "未就绪" : "关闭"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {selected.hasClientSecret ? "已配置 Client Secret" : "尚未配置 Client Secret"}
              </span>
            </div>
            <div className="divide-y pt-2">
              <SettingsField label={`启用 ${selected.name} 登录`}>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
                />
              </SettingsField>
              <SettingsField label="首次登录自动创建团队">
                <Switch
                  checked={draft.allowRegistration}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, allowRegistration: v }))}
                />
              </SettingsField>
            </div>
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
                  {selected.hasClientSecret ? (
                    <span className="font-normal text-muted-foreground">（留空则保持原值）</span>
                  ) : null}
                </Label>
                <Input
                  id="oauth-client-secret"
                  type="password"
                  value={draft.clientSecret}
                  onChange={(e) => setDraft((d) => ({ ...d, clientSecret: e.target.value }))}
                  autoComplete="new-password"
                  placeholder={selected.hasClientSecret ? "••••••••" : "粘贴 client_secret"}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oauth-redirect">Redirect URI（只读）</Label>
                <Input
                  id="oauth-redirect"
                  readOnly
                  value={selected.redirectUri}
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
            <Button type="button" onClick={() => void saveProvider()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {saving ? "保存中…" : `保存 ${selected.name} 配置`}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
