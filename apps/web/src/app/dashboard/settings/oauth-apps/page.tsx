"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { GoogleCloudProvisionPanel } from "@/components/mcp/google-cloud-provision-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type OauthApp = {
  id: "github" | "google";
  name: string;
  description: string;
  docsUrl: string;
  scope: "platform" | "tenant";
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  redirectUri: string;
  fromEnv: boolean;
  ready: boolean;
  credentialKind: "oauth_client";
};

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

const EMPTY: Draft = { enabled: false, clientId: "", clientSecret: "", scopes: "" };

type ScopeTab = "tenant" | "platform";

/**
 * OAuth 客户端配置：
 * - 本租户：任意管理员可自建（用户自己的 Google/GitHub OAuth App）
 * - 整站：SaaS 超管 / OSS 管理员（默认回退）
 *
 * Google 不接受 API Key，仅 OAuth Client ID/Secret。
 */
export default function OauthAppsSettingsPage() {
  const me = useMe();
  const [tab, setTab] = useState<ScopeTab>("tenant");
  const [apps, setApps] = useState<OauthApp[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [redirectUri, setRedirectUri] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // OSS：管理员可配整站；SaaS：仅超管
  const canPlatform = !me.multiTenant || me.isPlatformAdmin === true;

  const load = useCallback(async (scope: ScopeTab) => {
    setLoading(true);
    setForbidden(false);
    try {
      const res = await api<{
        apps: OauthApp[];
        redirectUri?: string;
        note?: string;
      }>(`/api/mcp/oauth-apps?scope=${scope}`);
      setApps(res.apps);
      if (res.redirectUri) setRedirectUri(res.redirectUri);
      if (res.note) setNote(res.note);
      const next: Record<string, Draft> = {};
      for (const a of res.apps) {
        next[a.id] = {
          enabled: a.enabled,
          clientId: a.fromEnv ? "" : a.clientId,
          clientSecret: "",
          scopes: a.fromEnv ? "" : a.scopes,
        };
      }
      setDrafts(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|管理员|platform/i.test(msg)) {
        setForbidden(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY), ...patch },
    }));
  }

  async function save(app: OauthApp) {
    const draft = drafts[app.id] ?? EMPTY;
    setSavingId(app.id);
    try {
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        clientId: draft.clientId,
        scopes: draft.scopes,
      };
      if (draft.clientSecret.trim()) {
        body.clientSecret = draft.clientSecret.trim();
      }
      const res = await api<{ app: OauthApp }>(
        `/api/mcp/oauth-apps/${app.id}?scope=${tab}`,
        { method: "PUT", json: body },
      );
      setApps((prev) => prev.map((a) => (a.id === app.id ? res.app : a)));
      setDrafts((prev) => ({
        ...prev,
        [app.id]: {
          enabled: res.app.enabled,
          clientId: res.app.clientId,
          clientSecret: "",
          scopes: res.app.scopes,
        },
      }));
      toast.success(`已保存 ${app.name}（${tab === "tenant" ? "本租户" : "整站"}）`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader title="OAuth 应用" />
      <p className="text-sm text-muted-foreground leading-relaxed">
        为无动态注册的上游 MCP（GitHub、Google Workspace）配置 OAuth 客户端。安装时也可临时填写自备
        Client ID/Secret，由本服务自动完成授权码流程。
        {note ? ` ${note}` : ""}
      </p>

      <div className="flex gap-1">
        <Button
          size="sm"
          variant={tab === "tenant" ? "default" : "outline"}
          onClick={() => setTab("tenant")}
        >
          本租户
        </Button>
        {canPlatform ? (
          <Button
            size="sm"
            variant={tab === "platform" ? "default" : "outline"}
            onClick={() => setTab("platform")}
          >
            整站默认
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {tab === "tenant"
          ? "优先使用本租户凭证；适合每位用户/组织自建 Google Cloud / GitHub OAuth App。"
          : "整站回退凭证；本租户未配置时使用。SaaS 仅超管可改。"}
      </p>

      {tab === "tenant" && !forbidden ? (
        <GoogleCloudProvisionPanel
          defaultScope="tenant"
          onClientReady={() => void load("tenant")}
        />
      ) : null}

      {loading ? (
        <>
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </>
      ) : forbidden ? (
        <p className="text-sm text-muted-foreground">当前账号无权管理此作用域的 OAuth 应用。</p>
      ) : (
        apps.map((app) => {
          const draft = drafts[app.id] ?? EMPTY;
          return (
            <SettingsSection key={`${tab}:${app.id}`} title={app.name}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {app.ready ? (
                  <Badge variant="default">已就绪</Badge>
                ) : (
                  <Badge variant="outline">未配置</Badge>
                )}
                {app.fromEnv ? <Badge variant="secondary">环境变量回退</Badge> : null}
                {app.hasClientSecret ? (
                  <Badge variant="secondary">已保存 Secret</Badge>
                ) : null}
                <Badge variant="outline" className={cn("text-[10px]")}>
                  OAuth Client
                </Badge>
                <a
                  href={app.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline"
                >
                  文档
                  <ExternalLink className="size-3" />
                </a>
              </div>
              <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
                {app.description}
              </p>

              <div className="space-y-4">
                <SettingsField label="启用">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(v) => updateDraft(app.id, { enabled: v })}
                  />
                </SettingsField>

                <SettingsField label="回调 URI（只读）">
                  <code className="block max-w-md break-all rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
                    {redirectUri || app.redirectUri}
                  </code>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    在 {app.name} 开发者控制台将此 URI 加入 Authorized redirect URIs。
                  </p>
                </SettingsField>

                <div className="space-y-1.5">
                  <Label className="text-xs">Client ID</Label>
                  <Input
                    value={draft.clientId}
                    placeholder={
                      app.fromEnv
                        ? `当前由环境变量提供：${app.clientId}`
                        : app.id === "google"
                          ? "*.apps.googleusercontent.com"
                          : ""
                    }
                    onChange={(e) => updateDraft(app.id, { clientId: e.target.value })}
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Client Secret{app.hasClientSecret ? "（留空则保持原值）" : ""}
                  </Label>
                  <Input
                    type="password"
                    value={draft.clientSecret}
                    placeholder={app.hasClientSecret ? "••••••••" : ""}
                    onChange={(e) =>
                      updateDraft(app.id, { clientSecret: e.target.value })
                    }
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">默认 Scopes（可选）</Label>
                  <Input
                    value={draft.scopes}
                    placeholder={
                      app.id === "google"
                        ? "留空则按 Gmail / Drive / Calendar 产品默认 scopes"
                        : "留空则使用上游 PRM scopes"
                    }
                    onChange={(e) => updateDraft(app.id, { scopes: e.target.value })}
                  />
                </div>

                <Button disabled={savingId === app.id} onClick={() => void save(app)}>
                  {savingId === app.id ? <Loader2 className="animate-spin" /> : null}
                  保存 {app.name}
                </Button>
              </div>
            </SettingsSection>
          );
        })
      )}
    </div>
  );
}
