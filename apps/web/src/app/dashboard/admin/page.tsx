"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { PlatformHeadscalePanel } from "@/components/platform-headscale-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";

type Platform = {
  setupCompleted: boolean;
  mode: "single-tenant" | "multi-tenant";
  multiTenant?: boolean;
  version: string;
};

type AdminTenant = {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  onboardingCompleted: boolean;
  memberCount: number;
  createdAt: string;
};

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
  redirectUri: string;
};

/** SaaS-only — stripped from OSS builds. Requires ZAKURA_EDITION=saas. */
export default function AdminPage() {
  const router = useRouter();
  const me = useMe();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [oauth, setOauth] = useState<ZerocatOauthConfig | null>(null);
  const [oauthDraft, setOauthDraft] = useState({
    enabled: false,
    clientId: "",
    clientSecret: "",
    authorizeUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scope: "",
    allowRegistration: true,
  });
  const [savingOauth, setSavingOauth] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!me.multiTenant || !me.isPlatformAdmin) {
        toast.error("超级管理后台仅在 SaaS 多租户部署下可用");
        router.replace("/dashboard/agents");
        return;
      }
      const [p, t, o] = await Promise.all([
        api<Platform>("/api/admin/platform"),
        api<{ tenants: AdminTenant[] }>("/api/admin/tenants"),
        api<ZerocatOauthConfig>("/api/admin/oauth/zerocat"),
      ]);
      setPlatform(p);
      setTenants(t.tenants);
      setOauth(o);
      setOauthDraft({
        enabled: o.enabled,
        clientId: o.clientId,
        clientSecret: "",
        authorizeUrl: o.authorizeUrl,
        tokenUrl: o.tokenUrl,
        userinfoUrl: o.userinfoUrl,
        scope: o.scope,
        allowRegistration: o.allowRegistration,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      router.replace("/dashboard/agents");
    } finally {
      setLoading(false);
    }
  }, [me.isPlatformAdmin, me.multiTenant, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveOauth() {
    setSavingOauth(true);
    try {
      const body: Record<string, unknown> = {
        enabled: oauthDraft.enabled,
        clientId: oauthDraft.clientId,
        authorizeUrl: oauthDraft.authorizeUrl,
        tokenUrl: oauthDraft.tokenUrl,
        userinfoUrl: oauthDraft.userinfoUrl,
        scope: oauthDraft.scope,
        allowRegistration: oauthDraft.allowRegistration,
      };
      if (oauthDraft.clientSecret.trim()) {
        body.clientSecret = oauthDraft.clientSecret.trim();
      }
      const saved = await api<ZerocatOauthConfig>("/api/admin/oauth/zerocat", {
        method: "PUT",
        json: body,
      });
      setOauth(saved);
      setOauthDraft((d) => ({ ...d, clientSecret: "", enabled: saved.enabled }));
      toast.success(saved.ready ? "ZeroCat OAuth 已保存并可用" : "已保存（请确认 Client ID / Secret）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOauth(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader title="超级管理员" />

      <SettingsSection title="部署模式">
        <p className="mb-3 text-sm text-muted-foreground">
          模式由环境变量控制（ZAKURA_MULTI_TENANT），不可在此修改。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">{platform?.mode}</Badge>
          <span className="text-xs text-muted-foreground">版本 {platform?.version}</span>
        </div>
      </SettingsSection>

      <PlatformHeadscalePanel />

      <SettingsSection title="登录 OAuth · ZeroCat">
        <p className="text-sm text-muted-foreground">
          在 ZeroCat 控制台创建 OAuth 应用，回调地址须与下方 Redirect URI 完全一致。Client Secret
          仅存服务端加密存储，不会返回前端。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant={oauth?.ready ? "default" : "secondary"}>
            {oauth?.ready ? "已启用" : oauthDraft.enabled ? "未就绪" : "关闭"}
          </Badge>
          {oauth?.hasClientSecret ? (
            <span className="text-xs text-muted-foreground">已配置 Client Secret</span>
          ) : (
            <span className="text-xs text-muted-foreground">尚未配置 Client Secret</span>
          )}
        </div>

        <div className="mt-4 space-y-4">
          <SettingsField label="启用 ZeroCat 登录">
            <Switch
              checked={oauthDraft.enabled}
              onCheckedChange={(v) => setOauthDraft((d) => ({ ...d, enabled: v }))}
            />
          </SettingsField>
          <SettingsField label="首次登录自动注册租户">
            <Switch
              checked={oauthDraft.allowRegistration}
              onCheckedChange={(v) => setOauthDraft((d) => ({ ...d, allowRegistration: v }))}
            />
          </SettingsField>

          <div className="space-y-1.5">
            <Label htmlFor="oauth-client-id">Client ID</Label>
            <Input
              id="oauth-client-id"
              value={oauthDraft.clientId}
              onChange={(e) => setOauthDraft((d) => ({ ...d, clientId: e.target.value }))}
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
              value={oauthDraft.clientSecret}
              onChange={(e) => setOauthDraft((d) => ({ ...d, clientSecret: e.target.value }))}
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
          <div className="space-y-1.5">
            <Label htmlFor="oauth-scope">Scope</Label>
            <Input
              id="oauth-scope"
              value={oauthDraft.scope}
              onChange={(e) => setOauthDraft((d) => ({ ...d, scope: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-authorize">Authorize URL</Label>
            <Input
              id="oauth-authorize"
              value={oauthDraft.authorizeUrl}
              onChange={(e) => setOauthDraft((d) => ({ ...d, authorizeUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-token">Token URL</Label>
            <Input
              id="oauth-token"
              value={oauthDraft.tokenUrl}
              onChange={(e) => setOauthDraft((d) => ({ ...d, tokenUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-userinfo">Userinfo URL</Label>
            <Input
              id="oauth-userinfo"
              value={oauthDraft.userinfoUrl}
              onChange={(e) => setOauthDraft((d) => ({ ...d, userinfoUrl: e.target.value }))}
              className="font-mono text-xs"
            />
          </div>

          <Button type="button" onClick={() => void saveOauth()} disabled={savingOauth}>
            {savingOauth ? <Loader2 className="animate-spin" /> : null}
            {savingOauth ? "保存中…" : "保存 OAuth 配置"}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="全部租户">
        <Table>
          <THead>
            <TR>
              <TH>名称</TH>
              <TH>标识</TH>
              <TH>成员</TH>
              <TH>引导</TH>
            </TR>
          </THead>
          <TBody>
            {tenants.map((t) => (
              <TR key={t.id}>
                <TD>
                  <div className="font-medium">{t.name}</div>
                  {t.isDefault ? (
                    <span className="text-[11px] text-muted-foreground">默认</span>
                  ) : null}
                </TD>
                <TD className="font-mono text-xs">{t.slug}</TD>
                <TD>{t.memberCount}</TD>
                <TD>{t.onboardingCompleted ? "完成" : "未完成"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </SettingsSection>
    </div>
  );
}
