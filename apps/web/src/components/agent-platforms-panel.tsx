"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type { ConnectorOauthField } from "@/components/connections/connector-oauth-form";
import { BrandIcon } from "@/components/brand-icon";
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

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

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

const platformHomepages: Record<string, string> = {
  slack: "https://slack.com",
  discord: "https://discord.com",
  telegram: "https://telegram.org",
  teams: "https://teams.microsoft.com",
  gchat: "https://chat.google.com",
  whatsapp: "https://whatsapp.com",
  messenger: "https://messenger.com",
  github: "https://github.com",
  linear: "https://linear.app",
  webex: "https://webex.com",
  mattermost: "https://mattermost.com",
  twilio: "https://twilio.com",
  resend: "https://resend.com",
  weixin: "https://weixin.qq.com",
};

function platformFromRef(ref: string): string {
  return ref.replace(/^remote-/, "");
}

function isChatSdkConnector(c: ConnectorView): boolean {
  return c.ref.startsWith("remote-") || c.package.slug === "agent-remote";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentPlatformsPanel({ agentId }: { agentId: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [allBindings, setAllBindings] = useState<Binding[]>([]);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState("");
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [agentDefaultModel, setAgentDefaultModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [remoteError, setRemoteError] = useState("");

  // Sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [platform, setPlatform] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({});
  const [allowAll, setAllowAll] = useState(false);
  const [allowedUsers, setAllowedUsers] = useState("");
  const [model, setModel] = useState("");
  const [modelRouteId, setModelRouteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const agentBindings = useMemo(
    () => allBindings.filter((b) => b.agentId === agentId && b.platform !== "email"),
    [allBindings, agentId],
  );
  const remotePlatforms = useMemo(() => connectors.filter(isChatSdkConnector), [connectors]);
  const catalogConnector = useMemo(
    () =>
      connectors.find(
        (c) => platformFromRef(c.ref) === platform || c.ref === `remote-${platform}`,
      ) ?? null,
    [connectors, platform],
  );
  const editingBinding = useMemo(
    () => (editingId ? agentBindings.find((b) => b.id === editingId) ?? null : null),
    [agentBindings, editingId],
  );

  // Load
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setRemoteError("");
    try {
      const [connResult, models, cloud] = await Promise.all([
        api<{ connectors: ConnectorView[] }>("/api/connectors?scope=tenant"),
        listChatModels(),
        getCloudConfig(agentId).catch(() => null),
      ]);
      setChatModels(models);
      setAgentDefaultModel(cloud?.cloud.model?.trim() || null);
      setConnectors(connResult.connectors.filter(isChatSdkConnector));

      let remote: { bindings: Binding[]; webhookBaseUrl: string; initialized: boolean };
      try {
        remote = await api("/api/remote-channels");
        if (!remote.initialized) setRemoteError("远程通路尚未初始化");
      } catch (err) {
        remote = { bindings: [], webhookBaseUrl: "", initialized: false };
        setRemoteError(err instanceof Error ? err.message : String(err));
      }
      setAllBindings(remote.bindings);
      setWebhookBaseUrl(remote.webhookBaseUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    return subscribePlatformEvents((ev) => {
      if (ev.type !== "connector_notice") return;
      if (ev.agentId && ev.agentId !== agentId) return;
      if (ev.level === "error") toast.error(ev.message);
      else if (ev.level === "warn") toast.warning(ev.message);
      else toast.message(ev.message);
    });
  }, [agentId]);

  // Sync draft
  useEffect(() => {
    if (editingBinding) {
      setPlatform(editingBinding.platform);
      setLabelDraft(
        editingBinding.label || platformLabels[editingBinding.platform] || editingBinding.platform,
      );
      setProfileDraft({});
      setAllowAll(editingBinding.settings.allowAll === true);
      setAllowedUsers((editingBinding.settings.allowedUsers ?? []).join("\n"));
      setModel(editingBinding.settings.model ?? "");
      setModelRouteId(editingBinding.settings.modelRouteId ?? null);
      return;
    }
    if (platform) {
      setLabelDraft(platformLabels[platform] ?? platform);
      setProfileDraft({});
      setAllowAll(false);
      setAllowedUsers("");
      setModel("");
      setModelRouteId(null);
    }
  }, [editingBinding, platform]);

  function openAdd() {
    setEditingId(null);
    setPlatform("");
    setSheetOpen(true);
  }
  function openBinding(b: Binding) {
    setEditingId(b.id);
    setPlatform(b.platform);
    setSheetOpen(true);
  }
  function closeSheet() {
    setSheetOpen(false);
    setEditingId(null);
    setPlatform("");
  }

  async function save() {
    if (!platform) return;
    setSaving(true);
    try {
      if (!model && !agentDefaultModel && !chatModels.some((m) => m.isDefault)) {
        toast.warning("未设置模型，且 Agent / 团队也无默认模型");
      }
      const payload = {
        agentId,
        platform,
        label: labelDraft.trim() || platformLabels[platform] || platform,
        enabled: true,
        credentials: profileDraft,
        credentialsEnabled: true,
        settings: {
          allowAll,
          allowedUsers: allowedUsers.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
          pendingUsers: editingBinding?.settings.pendingUsers ?? [],
          ...(model ? { model, modelRouteId } : { model: "", modelRouteId: null }),
        },
      };
      const res = await api<{ binding: Binding }>(
        editingId ? `/api/remote-channels/${editingId}` : "/api/remote-channels",
        { method: editingId ? "PATCH" : "POST", json: payload },
      );
      setAllBindings((cur) => [...cur.filter((b) => b.id !== res.binding.id), res.binding]);
      setEditingId(res.binding.id);
      setProfileDraft({});
      toast.success(editingId ? "已保存" : "已添加");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editingId) return;
    if (!window.confirm("确认删除？凭据与绑定将一并移除。")) return;
    setSaving(true);
    try {
      await api(`/api/remote-channels/${editingId}`, { method: "DELETE" });
      closeSheet();
      toast.success("已删除");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function approvePending(userKey: string) {
    if (!editingId) return;
    setSaving(true);
    try {
      const res = await api<{ binding: Binding }>(
        `/api/remote-channels/${editingId}/access/approve`,
        { method: "POST", json: { userKey } },
      );
      setAllBindings((cur) => [...cur.filter((b) => b.id !== res.binding.id), res.binding]);
      toast.success(`已批准 ${userKey}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function denyPending(userKey: string) {
    if (!editingId) return;
    setSaving(true);
    try {
      const res = await api<{ binding: Binding }>(
        `/api/remote-channels/${editingId}/access/deny`,
        { method: "POST", json: { userKey } },
      );
      setAllBindings((cur) => [...cur.filter((b) => b.id !== res.binding.id), res.binding]);
      toast.success(`已拒绝 ${userKey}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const webhookUrl = editingId && webhookBaseUrl ? `${webhookBaseUrl}/${editingId}/webhook` : "";
  const defaultModelLabel =
    agentDefaultModel ||
    chatModels.find((m) => m.isDefault)?.name ||
    chatModels.find((m) => m.isDefault)?.alias ||
    "团队默认";

  const credentialFields = (catalogConnector?.auth.fields ?? []) as ConnectorOauthField[];

  // Model items for selector
  const modelItems = useMemo<ModelRouteSelectorItem[]>(() => {
    const items: ModelRouteSelectorItem[] = [
      { value: FOLLOW_DEFAULT, label: "跟随默认", hint: defaultModelLabel, keywords: ["default", "默认"] },
      ...chatModels.map((m) => ({
        value: m.alias,
        label: m.name,
        hint: m.upstream,
        keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
        providers: m.providers,
      })),
    ];
    if (model && model !== FOLLOW_DEFAULT && !chatModels.some((m) => m.alias === model)) {
      items.push({ value: model, label: model, keywords: [], providers: [] });
    }
    return items;
  }, [chatModels, defaultModelLabel, model]);

  // =========================================================================
  // Render
  // =========================================================================

  if (loading) {
    return (
      <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载中…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center">
        <p className="mb-3 text-sm text-muted-foreground">{loadError}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
      </div>
    );
  }

  return (
    <>
      {remoteError ? (
        <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">注意</span> {remoteError}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 stagger-children">
        {agentBindings.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => openBinding(b)}
            className={cn(
              "group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left",
              "surface-interactive hover:border-foreground/15",
              "transition-all duration-200 ease-out-soft",
            )}
          >
            <BrandIcon
              brandId={b.platform}
              name={platformLabels[b.platform] ?? b.platform}
              homepage={platformHomepages[b.platform]}
              size="md"
            />
            <div className="min-w-0 flex-1">
              <span className="truncate text-sm font-medium group-hover:underline underline-offset-2">
                {b.label || platformLabels[b.platform] || b.platform}
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {b.enabled ? "启用" : "未启用"}
              </p>
            </div>
            <div
              className={cn(
                "size-2 shrink-0 rounded-full",
                b.enabled ? "bg-success" : "bg-muted-foreground/30",
              )}
            />
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}

        <button
          type="button"
          onClick={openAdd}
          className={cn(
            "flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4",
            "text-sm text-muted-foreground",
            "surface-interactive hover:border-foreground/20 hover:text-foreground",
            "transition-all duration-200 ease-out-soft min-h-[4.5rem]",
          )}
        >
          <Plus className="size-4" />
          添加平台
        </button>
      </div>

      {/* ---- Sheet ---- */}
      <Sheet open={sheetOpen} onOpenChange={(o) => !o && closeSheet()}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader className="pb-2">
            <SheetTitle>
              {editingBinding
                ? editingBinding.label || platformLabels[platform] || platform
                : platform
                  ? `添加 ${platformLabels[platform] ?? platform}`
                  : "添加平台"}
            </SheetTitle>
            {!editingId ? (
              <SheetDescription>选择平台，填写凭据即可上线</SheetDescription>
            ) : null}
          </SheetHeader>

          <div className="flex flex-col gap-5 px-4 pb-6">
            {/* Platform picker */}
            {!editingId ? (
              <div className="grid grid-cols-3 gap-2">
                {remotePlatforms.map((c) => {
                  const p = platformFromRef(c.ref);
                  const active = platform === p;
                  return (
                    <button
                      key={c.ref}
                      type="button"
                      onClick={() => setPlatform(p)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg border p-2.5",
                        "transition-all duration-150 ease-out-soft",
                        active
                          ? "border-foreground bg-foreground/[0.04]"
                          : "border-border surface-interactive hover:border-foreground/15",
                      )}
                    >
                      <BrandIcon
                        brandId={c.package.slug}
                        name={c.name}
                        accent={c.package?.accent}
                        homepage={platformHomepages[p] ?? c.package?.homepage}
                        size="sm"
                      />
                      <span className="text-[11px] font-medium leading-tight">
                        {platformLabels[p] ?? c.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* Form — flat, no wrapper cards */}
            {platform && catalogConnector ? (
              <>
                {/* Name (compact) */}
                <div className="space-y-1">
                  <Label htmlFor="binding-label">名称</Label>
                  <Input
                    id="binding-label"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    placeholder={platformLabels[platform] ?? platform}
                  />
                </div>

                {/* Credential fields — inline, no card wrapper */}
                {credentialFields.length > 0 ? (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">凭据</legend>
                    {credentialFields.map((field) => (
                      <CredentialField
                        key={field.key}
                        field={field}
                        value={profileDraft[field.key] ?? ""}
                        configured={editingBinding?.configuredFields.includes(field.key) ?? false}
                        onChange={(v) => setProfileDraft((d) => ({ ...d, [field.key]: v }))}
                      />
                    ))}
                    {catalogConnector.auth.docsUrl ? (
                      <a
                        href={catalogConnector.auth.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        厂商文档
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </fieldset>
                ) : null}

                {/* Model */}
                <div className="space-y-1">
                  <Label>模型</Label>
                  <ModelRouteSelector
                    items={modelItems}
                    value={model.trim() ? model : FOLLOW_DEFAULT}
                    routeId={model ? modelRouteId : null}
                    onSelectionChange={(a, r) => {
                      if (!a || a === FOLLOW_DEFAULT) { setModel(""); setModelRouteId(null); return; }
                      setModel(a); setModelRouteId(r);
                    }}
                    disabled={chatModels.length === 0}
                    placeholder="跟随默认"
                    className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
                  />
                </div>

                {/* Access */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">开放访问</span>
                    <Switch checked={allowAll} onCheckedChange={setAllowAll} />
                  </div>
                  {!allowAll ? (
                    <div className="space-y-1">
                      <Label htmlFor="sheet-allowed">白名单</Label>
                      <Textarea
                        id="sheet-allowed"
                        value={allowedUsers}
                        onChange={(e) => setAllowedUsers(e.target.value)}
                        placeholder="每行一个用户 ID"
                        rows={2}
                      />
                    </div>
                  ) : null}
                  {!allowAll && (editingBinding?.settings.pendingUsers?.length ?? 0) > 0 ? (
                    <PendingUsers
                      users={editingBinding!.settings.pendingUsers!}
                      saving={saving}
                      onApprove={(k) => void approvePending(k)}
                      onDeny={(k) => void denyPending(k)}
                    />
                  ) : null}
                </div>

                {/* Webhook (read-only) */}
                {webhookUrl ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <ExternalLink className="size-3" />
                      Webhook
                    </div>
                    <code className="block break-all rounded-md bg-muted px-2.5 py-2 text-[11px] text-muted-foreground">
                      {webhookUrl}
                    </code>
                  </div>
                ) : editingId ? (
                  <p className="text-xs text-muted-foreground">保存后生成 Webhook 地址。</p>
                ) : null}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button className="flex-1" onClick={() => void save()} disabled={saving}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    保存
                  </Button>
                  {editingId ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive shrink-0"
                      onClick={() => void remove()}
                      disabled={saving}
                      title="删除"
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </>
            ) : platform && !catalogConnector ? (
              <p className="text-sm text-muted-foreground">找不到该平台的连接器定义。</p>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CredentialField({
  field,
  value,
  configured,
  onChange,
}: {
  field: ConnectorOauthField;
  value: string;
  configured: boolean;
  onChange: (v: string) => void;
}) {
  const placeholder = configured
    ? "已保存；留空保持原值"
    : field.placeholder ?? field.defaultValue ?? "";

  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label>{field.label}</Label>
        <Switch checked={value === "true"} onCheckedChange={(c) => onChange(String(c))} />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="space-y-1">
        <Label>{field.label}</Label>
        <select
          value={value || field.defaultValue || ""}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">请选择</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div className="space-y-1">
        <Label>{field.label}{field.required ? " *" : ""}</Label>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
        />
        {field.help ? <p className="text-[11px] text-muted-foreground">{field.help}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label>{field.label}{field.required ? " *" : ""}</Label>
      <Input
        type={field.type === "secret" ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {field.help ? <p className="text-[11px] text-muted-foreground">{field.help}</p> : null}
    </div>
  );
}

function PendingUsers({
  users,
  saving,
  onApprove,
  onDeny,
}: {
  users: Array<{ userKey: string; email?: string; displayName?: string; requestedAt: string }>;
  saving: boolean;
  onApprove: (k: string) => void;
  onDeny: (k: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">待审批（{users.length}）</div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {users.map((u) => (
          <li key={u.userKey} className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0 text-xs">
              <div className="truncate font-medium">{u.userKey}</div>
              <div className="truncate text-muted-foreground">
                {[u.displayName, u.email].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" disabled={saving} onClick={() => onApprove(u.userKey)}>
                批准
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => onDeny(u.userKey)}>
                拒绝
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
