"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import { ConnectorOauthForm, type ConnectorOauthField } from "@/components/connections/connector-oauth-form";
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
import { SkillInstallDialog } from "@/components/skills/skill-install-dialog";

type ConnectorCapability = {
  id: string;
  kind: string;
  ref: string;
  name: string;
  description?: string | null;
  config: Record<string, unknown>;
  installed?: boolean;
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
  const [installing, setInstalling] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [skillSource, setSkillSource] = useState("");
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [activeRef, setActiveRef] = useState("");
  const [emailWebhookUrl, setEmailWebhookUrl] = useState("");

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
  }, [connector]);

  const tools = useMemo(
    () => connector?.capabilities.filter((item) => item.kind === "tool") ?? [],
    [connector],
  );
  const skills = useMemo(
    () => connector?.capabilities.filter((item) => item.kind === "skill") ?? [],
    [connector],
  );
  const canManage = !!connector && !connector.lockedByPlatform;
  const fields = connector?.auth.fields ?? [];
  const settings = connector?.auth.settings ?? [];
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
  const directAvailable =
    !!connector &&
    connector.ready &&
    (connector.auth.kind !== "oauth2" &&
    connector.auth.kind !== "oauth2_dynamic"
      ? true
      : connector.authorized === true);

  useEffect(() => {
    if (!open || (!skills.length && !connector?.ref.startsWith("email-"))) return;
    void fetchAgents()
      .then(setAgents)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [connector?.ref, open, skills.length]);

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

  function installBuiltinSkill(skill: ConnectorCapability) {
    setSkillSource(String(skill.config.source ?? `builtin:${skill.ref}`));
    setSkillDialogOpen(true);
  }

  async function authorize() {
    if (!connector) return;
    setAuthorizing(true);
    try {
      const result = await api<{ authorizeUrl: string }>(
        `/api/connectors/${encodeURIComponent(connector.ref)}/oauth/start`,
        { method: "POST", json: {} },
      );
      window.location.assign(result.authorizeUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setAuthorizing(false);
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
                  <Badge variant="secondary">已配置</Badge>
                ) : (
                  <Badge variant="outline">待配置</Badge>
                )}
                {connector.auth.profile ? (
                  <Badge variant="outline">档案：{connector.profile.label}</Badge>
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

            <div className="space-y-7 px-5 py-5">
              {connector.lockedByPlatform ? (
                <div className="flex items-start gap-2 border-b border-border pb-5 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                  <p>管理员已整站预配此认证档案，团队无需重复配置，可直接授权并启用功能。</p>
                </div>
              ) : connector.auth.kind === "none" ? (
                <div className="border-b border-border pb-5 text-sm text-muted-foreground">
                  此连接器无需额外凭据，打开后即可安装能力。
                </div>
              ) : (
                <section>
                  <h2 className="mb-3 text-sm font-medium">认证与连接配置</h2>
                  <ConnectorOauthForm
                    title={authLabel(connector.auth.kind)}
                    description={
                      connector.auth.kind === "oauth2" || connector.auth.kind === "oauth2_dynamic"
                        ? "凭据由命名档案管理，配置一次即可供引用该档案的连接器使用。"
                        : "填写连接器声明的认证字段，保存后即可使用对应能力。"
                    }
                    fields={displayFields}
                    configuredFields={connector.configuredFields}
                    draft={draft}
                    onDraftChange={setDraft}
                    enabled={enabled}
                    onEnabledChange={setEnabled}
                    redirectUri={
                      connector.auth.kind === "oauth2" || connector.auth.kind === "oauth2_dynamic"
                        ? redirectUri
                        : undefined
                    }
                    docsUrl={connector.auth.docsUrl ?? connector.docsUrl}
                    canManage={canManage}
                    saving={saving}
                    onSave={() => void save()}
                    enableLabel="启用连接器"
                    enableHint={connector.profile.shared ? "此档案由多个连接器共享" : undefined}
                  />
                </section>
              )}

              {connector.auth.kind === "oauth2" || connector.auth.kind === "oauth2_dynamic" ? (
                <section className="flex items-center justify-between gap-3 border-b border-border pb-6">
                  <div>
                    <h2 className="text-sm font-medium">账号授权</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      授权结果只保存到当前连接器，不会创建 MCP 实例。
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={!connector.ready || authorizing}
                    onClick={() => void authorize()}
                  >
                    {authorizing ? <Loader2 className="animate-spin" /> : null}
                    {connector.authorized ? "重新授权" : "OAuth 授权"}
                  </Button>
                </section>
              ) : null}

              {settings.length ? (
                <section className="border-b border-border pb-6">
                  <h2 className="mb-3 text-sm font-medium">连接器设置</h2>
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
                </section>
              ) : null}

              {connector.ref.startsWith("email-") && emailWebhookUrl ? (
                <section className="rounded-lg border border-dashed border-border p-3">
                  <h2 className="text-sm font-medium">入站 Webhook</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    在下方启用「收到邮件时触发 Agent」并配置白名单与密钥后使用。
                    邮箱工具连接器在此配置；Agent 消息平台（Chat SDK）请到 Agent → 平台。
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

              {tools.length ? (
                <section>
                  <div className="mb-3">
                    <h2 className="text-sm font-medium">功能</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      连接器启用并完成认证后，功能会直接提供给 Agent，无需安装 MCP。
                    </p>
                  </div>
                  <div className="divide-y divide-border border-y border-border">
                    {tools.map((tool) => (
                      <div key={tool.ref} className="flex items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{tool.name}</span>
                            {directAvailable ? (
                              <Badge variant="secondary">直接提供</Badge>
                            ) : null}
                          </div>
                          {tool.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {directAvailable ? "已接入" : "完成认证后可用"}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {skills.length ? (
                <section>
                  <div className="mb-3">
                    <h2 className="text-sm font-medium">Agent 技能</h2>
                  </div>
                  <div className="divide-y divide-border border-y border-border">
                    {skills.map((skill) => (
                      <div key={skill.ref} className="flex items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <span className="text-sm font-medium">{skill.name}</span>
                          {skill.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant={skill.installed ? "outline" : "default"}
                          disabled={!!installing}
                          onClick={() => void installBuiltinSkill(skill)}
                        >
                          {installing === skill.ref ? <Loader2 className="animate-spin" /> : null}
                          {skill.installed ? "已安装" : "安装"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
      <SkillInstallDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        source={skillSource}
        agents={agents}
        onInstalled={() => onChanged()}
      />
    </Sheet>
  );
}
