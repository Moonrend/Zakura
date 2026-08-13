"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  ConnectorOauthForm,
  type ConnectorOauthField,
} from "@/components/connections/connector-oauth-form";
import { api } from "@/lib/api";
import { subscribePlatformEvents } from "@/lib/platform-events";
import {
  getCloudConfig,
  listChatModels,
  type ChatModelOption,
} from "@/lib/cloud-agent";
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import type { ConnectorView } from "@/components/connections/connector-config-sheet";
import { cn } from "@/lib/utils";

type Binding = {
  id: string;
  agentId: string;
  platform: string;
  profileKey: string;
  label: string;
  enabled: boolean;
  credentialsEnabled: boolean;
  configuredFields: string[];
  settings: {
    allowAll?: boolean;
    allowedUsers?: string[];
    pendingUsers?: Array<{
      userKey: string;
      email?: string;
      displayName?: string;
      requestedAt: string;
    }>;
    model?: string;
    modelRouteId?: string | null;
  };
};

/** 显式跟随 Agent / 团队默认模型 */
const FOLLOW_DEFAULT = "__follow_default__";

const platformLabels: Record<string, string> = {
  resend: "Resend Email",
  webex: "Webex",
  mattermost: "Mattermost",
  weixin: "微信 Weixin",
  slack: "Slack",
  teams: "Microsoft Teams",
  gchat: "Google Chat",
  discord: "Discord",
  telegram: "Telegram",
  github: "GitHub",
  linear: "Linear",
  whatsapp: "WhatsApp",
  twilio: "Twilio",
  messenger: "Messenger",
};

function platformFromRef(ref: string): string {
  return ref.replace(/^remote-/, "");
}

function isChatSdkConnector(connector: ConnectorView): boolean {
  return connector.ref.startsWith("remote-") || connector.package.slug === "agent-remote";
}

export function AgentPlatformsPanel({ agentId }: { agentId: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [allBindings, setAllBindings] = useState<Binding[]>([]);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Catalog platform type being added or edited (e.g. slack) */
  const [selectedPlatform, setSelectedPlatform] = useState("");
  /** Existing binding id when editing; empty when creating a new instance */
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({});
  const [profileEnabled, setProfileEnabled] = useState(true);
  const [bindingEnabled, setBindingEnabled] = useState(true);
  const [bindingAllowAll, setBindingAllowAll] = useState(false);
  const [bindingAllowedUsers, setBindingAllowedUsers] = useState("");
  const [bindingModel, setBindingModel] = useState("");
  const [bindingModelRouteId, setBindingModelRouteId] = useState<string | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [agentDefaultModel, setAgentDefaultModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [remoteError, setRemoteError] = useState("");
  const [saving, setSaving] = useState(false);

  const agentBindings = useMemo(
    () =>
      allBindings.filter(
        (item) => item.agentId === agentId && item.platform !== "email",
      ),
    [allBindings, agentId],
  );

  const catalogConnector = useMemo(
    () =>
      connectors.find(
        (c) =>
          platformFromRef(c.ref) === selectedPlatform ||
          c.ref === `remote-${selectedPlatform}`,
      ) ?? null,
    [connectors, selectedPlatform],
  );

  const editingBinding = useMemo(
    () =>
      editingBindingId
        ? agentBindings.find((item) => item.id === editingBindingId) ?? null
        : null,
    [agentBindings, editingBindingId],
  );

  const remotePlatforms = useMemo(
    () => connectors.filter(isChatSdkConnector),
    [connectors],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setRemoteError("");
    try {
      const [connectorResult, models, cloud] = await Promise.all([
        api<{ connectors: ConnectorView[] }>("/api/connectors?scope=tenant"),
        listChatModels(),
        getCloudConfig(agentId).catch(() => null),
      ]);
      setChatModels(models);
      setAgentDefaultModel(cloud?.cloud.model?.trim() || null);

      let remoteResult: {
        bindings: Binding[];
        webhookBaseUrl: string;
        initialized: boolean;
      };
      try {
        remoteResult = await api<{
          bindings: Binding[];
          webhookBaseUrl: string;
          initialized: boolean;
        }>("/api/remote-channels");
        if (!remoteResult.initialized) setRemoteError("远程通路尚未初始化");
      } catch (error) {
        remoteResult = {
          bindings: [],
          webhookBaseUrl: "",
          initialized: false,
        };
        setRemoteError(error instanceof Error ? error.message : String(error));
      }
      setConnectors(connectorResult.connectors.filter(isChatSdkConnector));
      setAllBindings(remoteResult.bindings);
      setWebhookBaseUrl(remoteResult.webhookBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return subscribePlatformEvents((ev) => {
      if (ev.type !== "connector_notice") return;
      if (ev.agentId && ev.agentId !== agentId) return;
      if (ev.level === "error") toast.error(ev.message);
      else if (ev.level === "warn") toast.warning(ev.message);
      else toast.message(ev.message);
    });
  }, [agentId]);

  useEffect(() => {
    if (editingBinding) {
      setSelectedPlatform(editingBinding.platform);
      setLabelDraft(editingBinding.label || platformLabels[editingBinding.platform] || editingBinding.platform);
      setProfileDraft({});
      setProfileEnabled(editingBinding.credentialsEnabled);
      setBindingEnabled(editingBinding.enabled);
      setBindingAllowAll(editingBinding.settings.allowAll === true);
      setBindingAllowedUsers((editingBinding.settings.allowedUsers ?? []).join("\n"));
      setBindingModel(editingBinding.settings.model ?? "");
      setBindingModelRouteId(editingBinding.settings.modelRouteId ?? null);
      return;
    }
    if (selectedPlatform) {
      const label = platformLabels[selectedPlatform] ?? selectedPlatform;
      setLabelDraft(label);
      setProfileDraft({});
      setProfileEnabled(true);
      setBindingEnabled(true);
      setBindingAllowAll(false);
      setBindingAllowedUsers("");
      setBindingModel("");
      setBindingModelRouteId(null);
    }
  }, [editingBinding, selectedPlatform]);

  function openAddDialog() {
    setEditingBindingId(null);
    setSelectedPlatform("");
    setDialogOpen(true);
  }

  function openBinding(binding: Binding) {
    setEditingBindingId(binding.id);
    setSelectedPlatform(binding.platform);
    setDialogOpen(true);
  }

  function choosePlatform(platform: string) {
    setEditingBindingId(null);
    setSelectedPlatform(platform);
  }

  async function saveInstance() {
    if (!selectedPlatform) return;
    setSaving(true);
    try {
      if (bindingEnabled && !bindingModel && !agentDefaultModel) {
        const hasTenantDefault = chatModels.some((m) => m.isDefault);
        if (!hasTenantDefault) {
          toast.warning("未设置模型，且 Agent / 团队也无默认模型");
        }
      }
      const payload = {
        agentId,
        platform: selectedPlatform,
        label: labelDraft.trim() || platformLabels[selectedPlatform] || selectedPlatform,
        enabled: bindingEnabled,
        credentials: profileDraft,
        credentialsEnabled: profileEnabled,
        settings: {
          allowAll: bindingAllowAll,
          allowedUsers: bindingAllowedUsers
            .split(/[\n,;]+/)
            .map((item) => item.trim())
            .filter(Boolean),
          pendingUsers: editingBinding?.settings.pendingUsers ?? [],
          ...(bindingModel
            ? { model: bindingModel, modelRouteId: bindingModelRouteId }
            : { model: "", modelRouteId: null }),
        },
      };
      const response = await api<{ binding: Binding }>(
        editingBindingId
          ? `/api/remote-channels/${editingBindingId}`
          : "/api/remote-channels",
        {
          method: editingBindingId ? "PATCH" : "POST",
          json: payload,
        },
      );
      setAllBindings((current) => [
        ...current.filter((item) => item.id !== response.binding.id),
        response.binding,
      ]);
      setEditingBindingId(response.binding.id);
      setProfileDraft({});
      toast.success(editingBindingId ? "已保存" : "已添加连接器");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteInstance() {
    if (!editingBindingId) return;
    if (!window.confirm("删除此连接器实例？凭据与绑定将一并移除。")) return;
    setSaving(true);
    try {
      await api(`/api/remote-channels/${editingBindingId}`, { method: "DELETE" });
      setDialogOpen(false);
      setEditingBindingId(null);
      setSelectedPlatform("");
      toast.success("已删除");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function approvePendingUser(userKey: string) {
    if (!editingBindingId) return;
    setSaving(true);
    try {
      const response = await api<{ binding: Binding }>(
        `/api/remote-channels/${editingBindingId}/access/approve`,
        { method: "POST", json: { userKey } },
      );
      setAllBindings((current) => [
        ...current.filter((item) => item.id !== response.binding.id),
        response.binding,
      ]);
      toast.success(`已批准 ${userKey}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function denyPendingUser(userKey: string) {
    if (!editingBindingId) return;
    setSaving(true);
    try {
      const response = await api<{ binding: Binding }>(
        `/api/remote-channels/${editingBindingId}/access/deny`,
        { method: "POST", json: { userKey } },
      );
      setAllBindings((current) => [
        ...current.filter((item) => item.id !== response.binding.id),
        response.binding,
      ]);
      toast.success(`已拒绝 ${userKey}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const dialogTitle = selectedPlatform
    ? editingBinding
      ? editingBinding.label || platformLabels[selectedPlatform] || selectedPlatform
      : `添加 ${platformLabels[selectedPlatform] ?? selectedPlatform}`
    : "添加连接器";

  const webhookUrl =
    editingBindingId && webhookBaseUrl
      ? `${webhookBaseUrl}/${editingBindingId}/webhook`
      : "";

  const defaultModelLabel =
    agentDefaultModel ||
    chatModels.find((m) => m.isDefault)?.name ||
    chatModels.find((m) => m.isDefault)?.alias ||
    "团队默认";

  const samePlatformCount = (platform: string) =>
    agentBindings.filter((item) => item.platform === platform).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openAddDialog}>
          <Plus />
          添加连接器
        </Button>
      </div>

      {remoteError ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">注意</span> {remoteError}
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中…
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-dashed py-10 text-center">
          <p className="mb-3 text-sm text-muted-foreground">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : agentBindings.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-3 text-sm text-muted-foreground">尚未接入消息平台</p>
          <p className="mb-4 text-xs text-muted-foreground">
            每个连接器实例拥有独立凭据，同一平台可添加多个。
          </p>
          <Button size="sm" variant="outline" onClick={openAddDialog}>
            <Plus />
            添加连接器
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agentBindings.map((binding) => (
            <button
              key={binding.id}
              type="button"
              onClick={() => openBinding(binding)}
              className={cn(
                "group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left",
                "surface-interactive hover:border-foreground/15",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium group-hover:underline underline-offset-2">
                  {binding.label || platformLabels[binding.platform] || binding.platform}
                </span>
                <Badge
                  variant={binding.enabled ? "secondary" : "outline"}
                  className="shrink-0"
                >
                  {binding.enabled ? "运行中" : "未启用"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {platformLabels[binding.platform] ?? binding.platform}
                {binding.configuredFields.length
                  ? ` · ${binding.configuredFields.length} 项凭据`
                  : " · 未配置凭据"}
              </p>
            </button>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[min(90vh,860px)] overflow-y-auto sm:max-w-2xl">
          {!selectedPlatform ? (
            <>
              <DialogHeader>
                <DialogTitle>添加连接器</DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground">每个实例凭据独立</p>
              {remotePlatforms.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  未找到 Chat SDK 平台连接器。请确认「远程 Agent」集成包已同步。
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {remotePlatforms.map((connector) => {
                    const platform = platformFromRef(connector.ref);
                    const label = platformLabels[platform] ?? connector.name;
                    const count = samePlatformCount(platform);
                    return (
                      <button
                        key={connector.ref}
                        type="button"
                        onClick={() => choosePlatform(platform)}
                        className={cn(
                          "rounded-lg border border-border px-3 py-3 text-left",
                          "surface-interactive hover:border-foreground/15",
                        )}
                      >
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {count > 0 ? `已有 ${count} 个实例 · 再添加` : "新建实例"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : catalogConnector ? (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => {
                      if (editingBindingId) {
                        setSelectedPlatform("");
                        setEditingBindingId(null);
                      } else {
                        setSelectedPlatform("");
                      }
                    }}
                  >
                    <ArrowLeft />
                  </Button>
                  <DialogTitle>{dialogTitle}</DialogTitle>
                </div>
              </DialogHeader>

              <div className="space-y-6">
                <div className="space-y-1.5">
                  <Label htmlFor="binding-label">名称</Label>
                  <Input
                    id="binding-label"
                    value={labelDraft}
                    onChange={(event) => setLabelDraft(event.target.value)}
                    placeholder={platformLabels[selectedPlatform] ?? selectedPlatform}
                  />
                  <p className="text-xs text-muted-foreground">
                    用于区分同一平台的多个连接器实例。
                  </p>
                </div>

                <ConnectorOauthForm
                  title="凭据（本实例）"
                  fields={catalogConnector.auth.fields as ConnectorOauthField[]}
                  configuredFields={editingBinding?.configuredFields ?? []}
                  draft={profileDraft}
                  onDraftChange={setProfileDraft}
                  enabled={profileEnabled}
                  onEnabledChange={setProfileEnabled}
                  docsUrl={catalogConnector.auth.docsUrl}
                  canManage
                  saving={saving}
                  onSave={() => void saveInstance()}
                  enableLabel="启用凭据"
                />

                <BindingSettings
                  platform={selectedPlatform}
                  enabled={bindingEnabled}
                  allowAll={bindingAllowAll}
                  allowedUsersText={bindingAllowedUsers}
                  pendingUsers={editingBinding?.settings.pendingUsers ?? []}
                  model={bindingModel}
                  modelRouteId={bindingModelRouteId}
                  chatModels={chatModels}
                  defaultModelLabel={defaultModelLabel}
                  saving={saving}
                  onEnabledChange={setBindingEnabled}
                  onAllowAllChange={setBindingAllowAll}
                  onAllowedUsersChange={setBindingAllowedUsers}
                  onApprovePending={(userKey) => void approvePendingUser(userKey)}
                  onDenyPending={(userKey) => void denyPendingUser(userKey)}
                  onModelChange={(alias, routeId) => {
                    setBindingModel(alias ?? "");
                    setBindingModelRouteId(routeId);
                  }}
                  onSave={() => void saveInstance()}
                  webhookUrl={webhookUrl || undefined}
                />

                {editingBindingId ? (
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void deleteInstance()}
                    disabled={saving}
                  >
                    <Trash2 />
                    删除此连接器
                  </Button>
                ) : null}
              </div>

              <DialogFooter className="mt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">找不到该平台的连接器定义。</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BindingSettings({
  enabled,
  allowAll = false,
  allowedUsersText = "",
  pendingUsers = [],
  model,
  modelRouteId,
  chatModels,
  defaultModelLabel,
  saving,
  onEnabledChange,
  onAllowAllChange,
  onAllowedUsersChange,
  onApprovePending,
  onDenyPending,
  onModelChange,
  onSave,
  platform,
  webhookUrl,
}: {
  platform?: string;
  enabled: boolean;
  allowAll?: boolean;
  allowedUsersText?: string;
  pendingUsers?: Array<{
    userKey: string;
    email?: string;
    displayName?: string;
    requestedAt: string;
  }>;
  model: string;
  modelRouteId: string | null;
  chatModels: ChatModelOption[];
  defaultModelLabel: string;
  saving: boolean;
  onEnabledChange: (value: boolean) => void;
  onAllowAllChange?: (value: boolean) => void;
  onAllowedUsersChange?: (value: string) => void;
  onApprovePending?: (userKey: string) => void;
  onDenyPending?: (userKey: string) => void;
  onModelChange: (alias: string | null, routeId: string | null) => void;
  onSave: () => void;
  webhookUrl?: string;
}) {
  const modelItems = useMemo<ModelRouteSelectorItem[]>(() => {
    const items: ModelRouteSelectorItem[] = [
      {
        value: FOLLOW_DEFAULT,
        label: "跟随默认",
        hint: defaultModelLabel,
        keywords: ["default", "默认", "跟随"],
      },
      ...chatModels.map((m) => ({
        value: m.alias,
        label: m.name,
        hint: m.upstream,
        keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
        providers: m.providers,
      })),
    ];
    if (model && model !== FOLLOW_DEFAULT && !chatModels.some((m) => m.alias === model)) {
      items.push({
        value: model,
        label: model,
        keywords: [],
        providers: [],
      });
    }
    return items;
  }, [chatModels, defaultModelLabel, model]);

  const selectedModelValue = model.trim() ? model : FOLLOW_DEFAULT;

  return (
    <section className="space-y-5 rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-medium">消息</h2>

      <div className="space-y-1.5">
        <Label>模型</Label>
        <ModelRouteSelector
          items={modelItems}
          value={selectedModelValue}
          routeId={model ? modelRouteId : null}
          onSelectionChange={(alias, routeId) => {
            if (!alias || alias === FOLLOW_DEFAULT) {
              onModelChange(null, null);
              return;
            }
            onModelChange(alias, routeId);
          }}
          disabled={chatModels.length === 0}
          placeholder="跟随默认"
          className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="text-sm font-medium">启用</div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>

      {onAllowAllChange && onAllowedUsersChange ? (
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">开放访问</div>
            <Switch checked={allowAll} onCheckedChange={onAllowAllChange} />
          </div>
          {!allowAll ? (
            <div className="space-y-1.5">
              <Label htmlFor="allowed-users">白名单用户 ID</Label>
              <Textarea
                id="allowed-users"
                value={allowedUsersText}
                onChange={(event) => onAllowedUsersChange(event.target.value)}
                placeholder={"每行一个 ID"}
                rows={3}
              />
            </div>
          ) : null}
          {!allowAll && pendingUsers.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm font-medium">待审批（{pendingUsers.length}）</div>
              <ul className="divide-y divide-border border border-border">
                {pendingUsers.map((item) => (
                  <li
                    key={item.userKey}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 text-xs">
                      <div className="truncate font-medium">{item.userKey}</div>
                      <div className="truncate text-muted-foreground">
                        {[item.displayName, item.email, item.requestedAt.slice(0, 19)]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => onApprovePending?.(item.userKey)}
                      >
                        批准
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => onDenyPending?.(item.userKey)}
                      >
                        拒绝
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {webhookUrl ? (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <ExternalLink className="size-3.5" />
            Webhook
          </div>
          <code className="block break-all rounded-md bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">
            {webhookUrl}
          </code>
          {platform === "telegram" ? (
            <code className="block overflow-x-auto rounded-md bg-muted p-2 text-[11px] text-muted-foreground">
              curl -X POST
              {" \"https://api.telegram.org/bot<BOT_TOKEN>/setWebhook\" "}
              -H "Content-Type: application/json" -d
              {" '{\"url\":\""}
              {webhookUrl}
              {"\",\"secret_token\":\"<SECRET_TOKEN>\"}'"}
            </code>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          保存后会生成此实例专属的 Webhook 地址。
        </p>
      )}

      <Button className="w-full" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 className="animate-spin" /> : <Save />}
        保存
      </Button>
    </section>
  );
}
