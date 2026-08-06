"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { PlatformHeadscalePanel } from "@/components/platform-headscale-panel";
import { PlatformSkillTokenPanel } from "@/components/skills/platform-skill-token-panel";
import { PlatformConnectorProvisionPanel } from "@/components/connections/platform-connector-provision";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

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
  disablePasswordLogin: boolean;
  redirectUri: string;
};

type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
  canUseLocalRunner: boolean;
  hasPassword: boolean;
  tenants: Array<{ tenantId: string; slug: string; name: string; role: string }>;
  createdAt: string;
};

type AdminRunner = {
  id: string;
  name: string;
  slug: string;
  status: string;
  isShared: boolean;
  tenantId: string;
  tenantSlug: string | null;
  tenantName: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  ownerIsPlatformAdmin: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

type AgentDefaults = {
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  searchEngine: string | null;
  fetchBackend: string | null;
  autoManagedServices: string[];
};

type ManagedService = {
  key: string;
  name: string;
  description: string;
  mode: string;
  healthStatus: string;
  mapsTo?: { kind: string; id: string };
};

type WebCatalog = {
  webSearch: { engines: Array<{ id: string; name: string }> };
  webFetch: { backends: Array<{ id: string; name: string }> };
};

/** SaaS-only — stripped from OSS builds. Requires ZAKURA_EDITION=saas. */
export default function AdminPage() {
  const router = useRouter();
  const me = useMe();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [runners, setRunners] = useState<AdminRunner[]>([]);
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
    disablePasswordLogin: false,
  });
  const [savingOauth, setSavingOauth] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [busyRunnerId, setBusyRunnerId] = useState<string | null>(null);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults | null>(null);
  const [savingAgentDefaults, setSavingAgentDefaults] = useState(false);
  const [managedServices, setManagedServices] = useState<ManagedService[]>([]);
  const [webCatalog, setWebCatalog] = useState<WebCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!me.multiTenant || !me.isPlatformAdmin) {
        toast.error("超级管理后台仅在 SaaS 多团队部署下可用");
        router.replace("/dashboard/agents");
        return;
      }
      const [p, t, o, u, r, defaults, managed, catalog] = await Promise.all([
        api<Platform>("/api/admin/platform"),
        api<{ tenants: AdminTenant[] }>("/api/admin/tenants"),
        api<ZerocatOauthConfig>("/api/admin/oauth/zerocat"),
        api<{ users: AdminUser[] }>("/api/admin/users"),
        api<{ runners: AdminRunner[] }>("/api/admin/runners"),
        api<AgentDefaults>("/api/admin/agent-defaults"),
        api<{ services: ManagedService[] }>("/api/platform-services"),
        api<WebCatalog>("/api/capabilities"),
      ]);
      setPlatform(p);
      setTenants(t.tenants);
      setUsers(u.users);
      setRunners(r.runners);
      setAgentDefaults(defaults);
      setManagedServices(managed.services.filter((s) => s.mode !== "disabled"));
      setWebCatalog(catalog);
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
        disablePasswordLogin: o.disablePasswordLogin,
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
        disablePasswordLogin: oauthDraft.disablePasswordLogin,
      };
      if (oauthDraft.clientSecret.trim()) {
        body.clientSecret = oauthDraft.clientSecret.trim();
      }
      const saved = await api<ZerocatOauthConfig>("/api/admin/oauth/zerocat", {
        method: "PUT",
        json: body,
      });
      setOauth(saved);
      setOauthDraft((d) => ({
        ...d,
        clientSecret: "",
        enabled: saved.enabled,
        disablePasswordLogin: saved.disablePasswordLogin,
      }));
      toast.success(saved.ready ? "ZeroCat OAuth 已保存并可用" : "已保存（请确认 Client ID / Secret）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOauth(false);
    }
  }

  async function patchUser(
    userId: string,
    patch: { canUseLocalRunner?: boolean; isPlatformAdmin?: boolean },
  ) {
    setBusyUserId(userId);
    try {
      const res = await api<{ user: AdminUser }>(`/api/admin/users/${userId}`, {
        method: "PATCH",
        json: patch,
      });
      setUsers((list) =>
        list.map((u) =>
          u.id === userId
            ? {
                ...u,
                canUseLocalRunner: res.user.canUseLocalRunner,
                isPlatformAdmin: res.user.isPlatformAdmin,
              }
            : u,
        ),
      );
      toast.success("已更新用户权限");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUserId(null);
    }
  }

  async function toggleSharedRunner(runnerId: string, isShared: boolean) {
    setBusyRunnerId(runnerId);
    try {
      const res = await api<{ runner: { id: string; isShared: boolean } }>(
        `/api/admin/runners/${runnerId}`,
        { method: "PATCH", json: { isShared } },
      );
      setRunners((list) =>
        list.map((r) => (r.id === runnerId ? { ...r, isShared: res.runner.isShared } : r)),
      );
      toast.success(isShared ? "已设为共享 Runner" : "已取消共享");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRunnerId(null);
    }
  }

  async function saveAgentDefaults() {
    if (!agentDefaults) return;
    setSavingAgentDefaults(true);
    try {
      const saved = await api<AgentDefaults>("/api/admin/agent-defaults", {
        method: "PUT",
        json: agentDefaults,
      });
      setAgentDefaults(saved);
      toast.success("Agent 默认配置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAgentDefaults(false);
    }
  }

  async function applyAgentDefaults(userId: string) {
    setBusyUserId(userId);
    try {
      const result = await api<{ updated: number }>(
        `/api/admin/users/${userId}/agent-defaults/apply`,
        { method: "POST" },
      );
      toast.success(`已为该用户回溯启用 ${result.updated} 个 Agent`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUserId(null);
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
          模式由环境变量控制（ZAKURA_EDITION=saas），不可在此修改。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">{platform?.mode}</Badge>
          <span className="text-xs text-muted-foreground">版本 {platform?.version}</span>
        </div>
      </SettingsSection>

      <PlatformHeadscalePanel />

      <PlatformSkillTokenPanel />

      <PlatformConnectorProvisionPanel />

      {agentDefaults ? (
        <SettingsSection title="Agent 默认网页工具">
          <p className="mb-4 text-sm text-muted-foreground">
            新建 Agent 和未单独覆盖的 Agent 会跟随这里的设置。平台托管服务只对租户提供使用能力，连接地址和凭据不会下发。
          </p>
          <div className="space-y-3">
            <SettingsField label="默认启用网页搜索">
              <Switch checked={agentDefaults.webSearchEnabled} onCheckedChange={(v) => setAgentDefaults((d) => d && ({ ...d, webSearchEnabled: v }))} />
            </SettingsField>
            <SettingsField label="默认启用网页抓取">
              <Switch checked={agentDefaults.webFetchEnabled} onCheckedChange={(v) => setAgentDefaults((d) => d && ({ ...d, webFetchEnabled: v }))} />
            </SettingsField>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="platform-default-search">默认搜索引擎</Label>
                <select
                  id="platform-default-search"
                  value={agentDefaults.searchEngine ?? ""}
                  onChange={(e) => setAgentDefaults((d) => d && ({ ...d, searchEngine: e.target.value || null }))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">跟随网页配置</option>
                  {(webCatalog?.webSearch.engines ?? []).map((item) => {
                    const isAuto = managedServices.some(
                      (s) =>
                        s.mapsTo?.kind === "search-engine" &&
                        s.mapsTo.id === item.id &&
                        agentDefaults.autoManagedServices.includes(s.key),
                    );
                    return (
                      <option key={item.id} value={item.id}>
                        {isAuto ? "Zakura 自动" : item.name}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="platform-default-fetch">默认抓取后端</Label>
                <select
                  id="platform-default-fetch"
                  value={agentDefaults.fetchBackend ?? ""}
                  onChange={(e) => setAgentDefaults((d) => d && ({ ...d, fetchBackend: e.target.value || null }))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">跟随网页配置</option>
                  {(webCatalog?.webFetch.backends ?? []).map((item) => {
                    const isAuto = managedServices.some(
                      (s) =>
                        s.mapsTo?.kind === "fetch-backend" &&
                        s.mapsTo.id === item.id &&
                        agentDefaults.autoManagedServices.includes(s.key),
                    );
                    return (
                      <option key={item.id} value={item.id}>
                        {isAuto ? "Zakura 自动" : item.name}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {managedServices.length ? (
              <div className="space-y-3 pt-2">
                <div>
                  <Label>平台默认自托管服务（Zakura 自动）</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    选中的服务会作为租户网页配置里的「Zakura 自动」选项；连接地址与凭据不会下发。每种能力最多选一个。
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="platform-auto-search">默认搜索（平台托管）</Label>
                    <select
                      id="platform-auto-search"
                      value={
                        agentDefaults.autoManagedServices.find((key) => {
                          const svc = managedServices.find((s) => s.key === key);
                          return svc?.mapsTo?.kind === "search-engine";
                        }) ?? ""
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        setAgentDefaults((current) => {
                          if (!current) return current;
                          const withoutSearch = current.autoManagedServices.filter((key) => {
                            const svc = managedServices.find((s) => s.key === key);
                            return svc?.mapsTo?.kind !== "search-engine";
                          });
                          return {
                            ...current,
                            autoManagedServices: next ? [...withoutSearch, next] : withoutSearch,
                          };
                        });
                      }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">不提供</option>
                      {managedServices
                        .filter((s) => s.mapsTo?.kind === "search-engine")
                        .map((service) => (
                          <option key={service.key} value={service.key}>
                            {service.name}
                            {service.healthStatus === "healthy" ? " · 健康" : ""}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="platform-auto-fetch">默认抓取（平台托管）</Label>
                    <select
                      id="platform-auto-fetch"
                      value={
                        agentDefaults.autoManagedServices.find((key) => {
                          const svc = managedServices.find((s) => s.key === key);
                          return svc?.mapsTo?.kind === "fetch-backend";
                        }) ?? ""
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        setAgentDefaults((current) => {
                          if (!current) return current;
                          const withoutFetch = current.autoManagedServices.filter((key) => {
                            const svc = managedServices.find((s) => s.key === key);
                            return svc?.mapsTo?.kind !== "fetch-backend";
                          });
                          return {
                            ...current,
                            autoManagedServices: next ? [...withoutFetch, next] : withoutFetch,
                          };
                        });
                      }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">不提供</option>
                      {managedServices
                        .filter((s) => s.mapsTo?.kind === "fetch-backend")
                        .map((service) => (
                          <option key={service.key} value={service.key}>
                            {service.name}
                            {service.healthStatus === "healthy" ? " · 健康" : ""}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <p className="pt-1 text-xs text-muted-foreground">
                尚未启用任何平台自托管服务。请先在「自托管服务」中部署或接入，再在此设为平台默认。
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void saveAgentDefaults()} disabled={savingAgentDefaults}>
                {savingAgentDefaults ? "保存中…" : "保存默认配置"}
              </Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

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
              onCheckedChange={(v) =>
                setOauthDraft((d) => ({
                  ...d,
                  enabled: v,
                  disablePasswordLogin: v ? d.disablePasswordLogin : false,
                }))
              }
            />
          </SettingsField>
          <SettingsField label="首次登录自动创建团队">
            <Switch
              checked={oauthDraft.allowRegistration}
              onCheckedChange={(v) => setOauthDraft((d) => ({ ...d, allowRegistration: v }))}
            />
          </SettingsField>
          <SettingsField label="禁止邮箱密码登录（仅 ZeroCat）">
            <Switch
              checked={oauthDraft.disablePasswordLogin}
              disabled={!oauthDraft.enabled}
              onCheckedChange={(v) => setOauthDraft((d) => ({ ...d, disablePasswordLogin: v }))}
            />
          </SettingsField>
          {oauthDraft.disablePasswordLogin ? (
            <p className="text-xs text-muted-foreground">
              开启后登录页只显示 ZeroCat；需 ZeroCat 配置完整可用后才会生效。
            </p>
          ) : null}

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

      <SettingsSection title="用户与 Local Runner 授权">
        <p className="mb-3 text-sm text-muted-foreground">
          SaaS 下使用本机（Server）Local Runner 需预先授权。平台管理员默认已授权；自托管部署不限制。
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>团队</TableHead>
              <TableHead>平台管理员</TableHead>
              <TableHead>Local Runner</TableHead>
              <TableHead>网页默认</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-medium">{u.name || u.email}</div>
                  <div className="text-[11px] text-muted-foreground">{u.email}</div>
                  {!u.hasPassword ? (
                    <span className="text-[11px] text-muted-foreground">OAuth</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyUserId === u.id}
                    onClick={() => void applyAgentDefaults(u.id)}
                  >
                    回溯启用
                  </Button>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {u.tenants.length
                    ? u.tenants.map((t) => `${t.name}(${t.role})`).join("、")
                    : "—"}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={u.isPlatformAdmin}
                    disabled={busyUserId === u.id}
                    onCheckedChange={(v) => void patchUser(u.id, { isPlatformAdmin: v })}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={u.canUseLocalRunner}
                    disabled={busyUserId === u.id || u.isPlatformAdmin}
                    onCheckedChange={(v) => void patchUser(u.id, { canUseLocalRunner: v })}
                  />
                </TableCell>
              </TableRow>
            ))}
            {!users.length ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  暂无用户
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SettingsSection>

      <SettingsSection title="共享 Runner">
        <p className="mb-3 text-sm text-muted-foreground">
          将管理员持有的远程 Runner 标记为共享后，任意团队都可绑定使用。共享 Runner
          每个团队同时仅允许 1 个活跃工作区（Agent 绑定不限），并禁止宿主机容器分配与归档；允许
          Cloudflare Quick Tunnel 端口暴露。
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>所属团队</TableHead>
              <TableHead>创建者</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>共享</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runners.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{r.slug}</div>
                </TableCell>
                <TableCell className="text-xs">
                  {r.tenantName ?? r.tenantSlug ?? r.tenantId}
                </TableCell>
                <TableCell className="text-xs">
                  {r.createdByEmail ?? "—"}
                  {r.ownerIsPlatformAdmin ? (
                    <Badge variant="secondary" className="ml-1">
                      管理员
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.status}</Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={r.isShared}
                    disabled={busyRunnerId === r.id}
                    onCheckedChange={(v) => void toggleSharedRunner(r.id, v)}
                  />
                </TableCell>
              </TableRow>
            ))}
            {!runners.length ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  暂无远程 Runner。请先在任一管理员团队下创建 Runner。
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SettingsSection>

      <SettingsSection title="全部团队">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>标识</TableHead>
              <TableHead>成员</TableHead>
              <TableHead>引导</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="font-medium">{t.name}</div>
                  {t.isDefault ? (
                    <span className="text-[11px] text-muted-foreground">默认</span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{t.slug}</TableCell>
                <TableCell>{t.memberCount}</TableCell>
                <TableCell>{t.onboardingCompleted ? "完成" : "未完成"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SettingsSection>
    </div>
  );
}
