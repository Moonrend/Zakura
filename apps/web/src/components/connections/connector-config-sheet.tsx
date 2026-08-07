"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import { ConnectorOauthForm, type ConnectorOauthField } from "@/components/connections/connector-oauth-form";
import {
  AgentTargetPicker,
  resolveAgentIds,
  type AgentTargetValue,
} from "@/components/agent-target-picker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { cn } from "@/lib/utils";

type ConnectorCapability = {
  id: string;
  kind: string;
  ref: string;
  name: string;
  description?: string | null;
  config: Record<string, unknown>;
  installed?: boolean;
};

type ConnectorInstallation = {
  id: string;
  agentId: string;
  agentName?: string;
  connectorRef: string;
  enabled: boolean;
  authorized: boolean;
  updatedAt: string;
};

export type ConnectorView = {
  id: string;
  ref: string;
  name: string;
  description?: string | null;
  status: string;
  ready: boolean;
  enabled: boolean;
  lockedByPlatform?: boolean;
  auth: {
    kind: "none" | "oauth2" | "oauth2_dynamic" | "token" | "custom";
    profile: string;
    profileLabel?: string;
    fields: ConnectorOauthField[];
    settings: ConnectorOauthField[];
    docsUrl?: string;
  };
  profile: {
    key: string;
    label: string;
    shared: boolean;
    connectorRefs: string[];
    configuredFields: string[];
    enabled: boolean;
  };
  configuredFields: string[];
  configuredSettings?: string[];
  authorized?: boolean;
  installations?: ConnectorInstallation[];
  docsUrl?: string;
  package: {
    slug: string;
    name: string;
    icon?: string | null;
    accent?: string | null;
    homepage?: string | null;
  };
  capabilities: ConnectorCapability[];
};

function authLabel(kind: ConnectorView["auth"]["kind"]) {
  switch (kind) {
    case "oauth2":
      return "OAuth 2.0";
    case "oauth2_dynamic":
      return "动态 OAuth";
    case "token":
      return "令牌";
    case "custom":
      return "自定义配置";
    default:
      return "无需配置";
  }
}

function needsOauthGrant(kind: ConnectorView["auth"]["kind"]) {
  return kind === "oauth2" || kind === "oauth2_dynamic";
}

function capabilityKindLabel(kind: string) {
  if (kind === "skill") return "技能";
  if (kind === "tool") return "功能";
  return kind;
}

export function ConnectorConfigSheet({
  connectors,
  redirectUri,
  open,
  onOpenChange,
  onChanged,
}: {
  connectors: ConnectorView[];
  redirectUri: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [authorizingAgentId, setAuthorizingAgentId] = useState<string | null>(null);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentTarget, setAgentTarget] = useState<AgentTargetValue>({ all: false, agentIds: [] });
  const [oauthAgentId, setOauthAgentId] = useState("");
  const [activeRef, setActiveRef] = useState("");
  const [emailWebhookUrl, setEmailWebhookUrl] = useState("");
  const [credOpen, setCredOpen] = useState(false);

  const connector = useMemo(
    () => connectors.find((item) => item.ref === activeRef) ?? connectors[0] ?? null,
    [activeRef, connectors],
  );

  useEffect(() => {
    setActiveRef(connectors[0]?.ref ?? "");
    setDraft({});
    setSettingsDraft({});
    setEmailWebhookUrl("");
  }, [connectors]);

  useEffect(() => {
    setDraft({});
    setSettingsDraft({});
    setEnabled(connector?.profile.enabled ?? connector?.enabled ?? false);
    setAgentTarget({ all: false, agentIds: [] });
    setOauthAgentId("");
    // 已配置则默认折叠；未配置则展开
    const configured =
      !!connector &&
      (connector.lockedByPlatform ||
        connector.ready ||
        connector.auth.kind === "none");
    setCredOpen(!configured);
  }, [connector]);

  const capabilities = useMemo(
    () =>
      (connector?.capabilities ?? []).filter(
        (item) => item.kind === "tool" || item.kind === "skill",
      ),
    [connector],
  );
  const installations = connector?.installations ?? [];
  const canManage = !!connector && !connector.lockedByPlatform;
  const fields = connector?.auth.fields ?? [];
  const settings = connector?.auth.settings ?? [];
  const showCredentialForm =
    !!connector &&
    !connector.lockedByPlatform &&
    connector.auth.kind !== "none";
  const displayFields = useMemo(
    () =>
      fields.map((field) =>
        field.key === "inboundAgentId"
          ? {
              ...field,
              type: "select" as const,
              options: agents.map((agent) => ({
                value: agent.id,
                label: `${agent.name}（${agent.slug}）`,
              })),
            }
          : field,
      ),
    [agents, fields],
  );
  const displaySettings = useMemo(
    () =>
      settings.map((field) =>
        field.key === "inboundAgentId"
          ? {
              ...field,
              type: "select" as const,
              options: agents.map((agent) => ({
                value: agent.id,
                label: `${agent.name}（${agent.slug}）`,
              })),
            }
          : field,
      ),
    [agents, settings],
  );

  useEffect(() => {
    if (!open) return;
    void fetchAgents()
      .then(setAgents)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [open]);

  useEffect(() => {
    if (!open || !connector?.ref.startsWith("email-")) return;
    void api<{ emailWebhookUrl?: string }>("/api/remote-channels")
      .then((result) => setEmailWebhookUrl(result.emailWebhookUrl ?? ""))
      .catch(() => setEmailWebhookUrl(""));
  }, [connector?.ref, open]);

  async function save() {
    if (!connector) return;
    setSaving(true);
    try {
      const result = await api<{ connector: ConnectorView }>(
        `/api/connectors/${encodeURIComponent(connector.id)}/credentials?scope=tenant`,
        {
          method: "PUT",
          json: { enabled, values: draft, settings: settingsDraft },
        },
      );
      setDraft({});
      setSettingsDraft({});
      setEnabled(result.connector.enabled);
      toast.success(`${result.connector.name} 配置已保存`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function enableOnAgents() {
    if (!connector) return;
    const agentIds = resolveAgentIds(agentTarget, agents);
    if (!agentIds.length) {
      toast.error("请选择 Agent");
      return;
    }
    setInstalling(true);
    try {
      await api(`/api/connectors/${encodeURIComponent(connector.ref)}/install`, {
        method: "POST",
        json: agentTarget.all ? { all: true } : { agentIds },
      });
      toast.success(`已为 ${agentIds.length} 个 Agent 安装`);
      setAgentTarget({ all: false, agentIds: [] });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  async function authorize(agentId: string) {
    if (!connector) return;
    if (!agentId) {
      toast.error("请选择要授权的 Agent");
      return;
    }
    setAuthorizingAgentId(agentId);
    try {
      const result = await api<{ authorizeUrl: string }>(
        `/api/connectors/${encodeURIComponent(connector.ref)}/oauth/start`,
        { method: "POST", json: { agentId } },
      );
      window.location.assign(result.authorizeUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setAuthorizingAgentId(null);
    }
  }

  async function revoke(agentId: string) {
    if (!connector) return;
    setRemovingAgentId(agentId);
    try {
      await api(
        `/api/connectors/${encodeURIComponent(connector.ref)}/installations/${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
      );
      toast.success("已卸载该 Agent 的连接器能力");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingAgentId(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">
        {connector ? (
          <>
            <SheetHeader className="border-b border-border px-5 py-5 pr-14">
              <div className="flex items-start gap-3">
                <BrandIcon
                  brandId={connector.ref}
                  name={connector.name}
                  accent={connector.package.accent}
                  homepage={connector.package.homepage}
                  size="md"
                />
                <div className="min-w-0">
                  <SheetTitle>{connector.name}</SheetTitle>
                  <SheetDescription className="mt-1">
                    {connector.description || connector.package.name}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{authLabel(connector.auth.kind)}</Badge>
                {connector.lockedByPlatform ? (
                  <Badge variant="secondary">整站已预配</Badge>
                ) : connector.ready ? (
                  <Badge variant="secondary">凭据已配置</Badge>
                ) : (
                  <Badge variant="outline">待配置</Badge>
                )}
                {installations.length ? (
                  <Badge variant="secondary">{installations.length} 个 Agent</Badge>
                ) : null}
              </div>
              {connectors.length > 1 ? (
                <label className="mt-4 block space-y-1.5">
                  <span className="text-xs text-muted-foreground">邮箱服务类型</span>
                  <select
                    value={connector.ref}
                    onChange={(event) => setActiveRef(event.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  >
                    {connectors.map((item) => (
                      <option key={item.ref} value={item.ref}>
                        {item.name}{item.ready ? " · 已配置" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </SheetHeader>

            <div className="space-y-6 px-5 py-5">
              {connector.lockedByPlatform ? (
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                  <p>管理员已整站预配此认证档案，直接为各 Agent 授权即可。</p>
                </div>
              ) : null}

              {showCredentialForm || settings.length ? (
                <Collapsible open={credOpen} onOpenChange={setCredOpen}>
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 py-1 text-left">
                    <div className="min-w-0">
                      <h2 className="text-sm font-medium">租户凭据配置</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {connector.ready
                          ? "已配置，点击展开修改"
                          : "客户端配置对当前租户全局生效"}
                      </p>
                    </div>
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        credOpen && "rotate-90",
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-3 space-y-5">
                    {showCredentialForm ? (
                      <ConnectorOauthForm
                        title={authLabel(connector.auth.kind)}
                        description={
                          needsOauthGrant(connector.auth.kind)
                            ? "凭据由命名档案管理，配置一次即可供引用该档案的连接器使用。"
                            : "填写连接器声明的认证字段，保存后即可为 Agent 安装。"
                        }
                        fields={displayFields}
                        configuredFields={connector.configuredFields}
                        draft={draft}
                        onDraftChange={setDraft}
                        enabled={enabled}
                        onEnabledChange={setEnabled}
                        redirectUri={
                          needsOauthGrant(connector.auth.kind) ? redirectUri : undefined
                        }
                        docsUrl={connector.auth.docsUrl ?? connector.docsUrl}
                        canManage={canManage}
                        saving={saving}
                        onSave={() => void save()}
                        enableLabel="启用连接器"
                        enableHint={
                          connector.profile.shared ? "此档案由多个连接器共享" : undefined
                        }
                      />
                    ) : null}
                    {settings.length ? (
                      <ConnectorOauthForm
                        title="实例设置"
                        fields={displaySettings}
                        configuredFields={connector.configuredSettings ?? []}
                        draft={settingsDraft}
                        onDraftChange={setSettingsDraft}
                        enabled
                        onEnabledChange={() => undefined}
                        canManage={canManage}
                        saving={saving}
                        onSave={() => void save()}
                      />
                    ) : null}
                  </CollapsibleContent>
                </Collapsible>
              ) : connector.auth.kind === "none" ? (
                <p className="text-sm text-muted-foreground">
                  此连接器无需额外凭据，为 Agent 安装后即可使用。
                </p>
              ) : null}

              <section>
                <h2 className="mb-1 text-sm font-medium">安装到 Agent</h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  {needsOauthGrant(connector.auth.kind)
                    ? "每个 Agent 单独授权；授权成功后一并安装功能与技能。"
                    : "为 Agent 安装后，功能与技能一并可用。"}
                </p>

                {capabilities.length ? (
                  <div className="mb-4 divide-y divide-border border-y border-border">
                    {capabilities.map((item) => (
                      <div key={`${item.kind}:${item.ref}`} className="py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{item.name}</span>
                          <Badge variant="outline">{capabilityKindLabel(item.kind)}</Badge>
                        </div>
                        {item.description ? (
                          <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {needsOauthGrant(connector.auth.kind) ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      value={oauthAgentId}
                      onChange={(event) => setOauthAgentId(event.target.value)}
                      disabled={!connector.ready || !!authorizingAgentId}
                      className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:flex-1"
                    >
                      <option value="">选择 Agent…</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}（{agent.slug}）
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={!connector.ready || !oauthAgentId || !!authorizingAgentId}
                      onClick={() => void authorize(oauthAgentId)}
                    >
                      {authorizingAgentId === oauthAgentId ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      授权并安装
                    </Button>
                  </div>
                ) : (
                  <>
                    <AgentTargetPicker
                      agents={agents}
                      value={agentTarget}
                      onChange={setAgentTarget}
                      disabled={!connector.ready || installing}
                    />
                    <div className="mt-3">
                      <Button
                        size="sm"
                        disabled={!connector.ready || installing}
                        onClick={() => void enableOnAgents()}
                      >
                        {installing ? <Loader2 className="animate-spin" /> : null}
                        安装
                      </Button>
                    </div>
                  </>
                )}

                {installations.length ? (
                  <div className="mt-4 divide-y divide-border border-y border-border">
                    {installations.map((row) => {
                      const agentName =
                        row.agentName ??
                        agents.find((agent) => agent.id === row.agentId)?.name ??
                        row.agentId;
                      const readyForTools = needsOauthGrant(connector.auth.kind)
                        ? row.authorized
                        : row.enabled;
                      return (
                        <div
                          key={row.id}
                          className="flex items-center justify-between gap-3 py-3"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{agentName}</span>
                              {readyForTools ? (
                                <Badge variant="secondary">已安装</Badge>
                              ) : (
                                <Badge variant="outline">未完成</Badge>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {needsOauthGrant(connector.auth.kind) ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={authorizingAgentId === row.agentId}
                                onClick={() => void authorize(row.agentId)}
                              >
                                {authorizingAgentId === row.agentId ? (
                                  <Loader2 className="animate-spin" />
                                ) : null}
                                重新授权
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={removingAgentId === row.agentId}
                              onClick={() => void revoke(row.agentId)}
                              aria-label="卸载"
                            >
                              {removingAgentId === row.agentId ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">尚未安装到任何 Agent</p>
                )}
              </section>

              {connector.ref.startsWith("email-") && emailWebhookUrl ? (
                <section className="rounded-lg border border-dashed border-border p-3">
                  <h2 className="text-sm font-medium">入站 Webhook</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    启用「收到邮件时触发 Agent」并配置白名单与密钥后使用。
                  </p>
                  <code className="mt-2 block break-all text-xs text-muted-foreground">
                    {`${emailWebhookUrl.replace(/\/$/, "")}/${connector.ref}`}
                  </code>
                </section>
              ) : null}

              {connector.package.homepage ? (
                <a
                  href={connector.package.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  查看连接器文档
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
