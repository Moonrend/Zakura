"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Container,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  ScrollText,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { subscribePlatformEvents } from "@/lib/platform-events";
import {
  listenMcpOauthCallback,
  navigateOauthTab,
  prepareOauthTab,
  startUpstreamOauth as startUpstreamOauthApi,
} from "@/lib/mcp-oauth";
import {
  McpPromptsExplorer,
  McpResourcesExplorer,
  McpToolsExplorer,
  type McpPromptRow,
  type McpResourceRow,
  type McpResourceTemplateRow,
  type McpToolRow,
} from "@/components/mcp/capability-explorers";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { McpToolPermissionsPanel } from "@/components/mcp/tool-permissions-panel";
import type { McpToolPermissionState } from "@/lib/mcp-config";

type InstanceDetail = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  provider?: { name?: string | null; category?: string | null } | null;
  status: string;
  healthStatus: string;
  endpointUrl?: string | null;
  lastError?: string | null;
  config?: Record<string, unknown>;
  containers?: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    dockerId?: string | null;
    portsJson: string;
  }>;
  tools?: McpToolRow[];
  resources?: McpResourceRow[];
  prompts?: McpPromptRow[];
  resourceTemplates?: McpResourceTemplateRow[];
  toolPermissions?: McpToolPermissionState[];
};

type RuntimeContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  mounts?: Array<{ source: string; target: string; mode?: string; type?: string }>;
};

const CONFIG_LABELS: Record<string, string> = {
  mcpUrl: "MCP 地址",
  headerName: "鉴权 Header",
  apiKey: "Token / API Key",
  command: "命令",
  args: "参数",
  env: "环境变量",
  image: "容器镜像",
  workingDir: "工作目录",
  packageManager: "包类型",
  oauthClientId: "客户端 ID / CIMD",
  oauthClientSecret: "客户端 Secret",
  oauthClientSource: "注册方式",
  oauthClientMode: "客户端模式",
  oauthAccessToken: "Access Token",
  oauthRefreshToken: "Refresh Token",
  oauthExpiresAt: "Token 过期时间",
  oauthAuthorizationEndpoint: "授权地址",
  oauthTokenEndpoint: "Token 地址",
  oauthRegistrationEndpoint: "注册地址",
  oauthRedirectUri: "回调地址",
  oauthResourceMetadataUrl: "资源元数据地址",
  oauthScopes: "Scopes",
};

const GENERIC_CONFIG_KEYS = [
  "mcpUrl",
  "headerName",
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
  "oauthClientSource",
  "oauthClientMode",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthExpiresAt",
  "oauthAuthorizationEndpoint",
  "oauthTokenEndpoint",
  "oauthRegistrationEndpoint",
  "oauthRedirectUri",
  "oauthResourceMetadataUrl",
  "oauthScopes",
];

const STDIO_CONFIG_KEYS = ["command", "args", "env", "image", "workingDir", "packageManager"];

function configKeys(instance: InstanceDetail) {
  const base = instance.providerId === "generic-mcp" ? GENERIC_CONFIG_KEYS : [];
  const runtime = instance.providerId === "stdio-mcp" ? STDIO_CONFIG_KEYS : [];
  return [...new Set([...base, ...runtime, ...Object.keys(instance.config ?? {})])].filter(
    (key) => key !== "authRequired",
  );
}

function displayConfigValue(value: unknown) {
  if (value == null) return "";
  if (value === "***") return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isSecretConfigKey(key: string) {
  return /secret|token|password|apikey|api_key/i.test(key);
}

function isJsonConfigKey(key: string, original?: unknown) {
  return key === "args" || key === "env" ||
    (original != null && typeof original === "object");
}

function isNumericConfigKey(key: string) {
  return key === "oauthExpiresAt";
}

function ConfigField({
  name,
  value,
  onChange,
  original,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  original: unknown;
}) {
  const secret = isSecretConfigKey(name);
  const placeholder = secret && original === "***" ? "已保存" : undefined;
  return (
    <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
      <Label className="pt-2 text-xs">{CONFIG_LABELS[name] ?? name}</Label>
      {isJsonConfigKey(name, original) ? (
        <Textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <Input
          type={secret ? "password" : isNumericConfigKey(name) ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />
      )}
    </div>
  );
}

function RuntimePanel({
  instance,
}: {
  instance: InstanceDetail;
}) {
  const fallback = (instance.containers ?? []).map((container) => ({
    id: container.id,
    runtime: {
      id: container.dockerId ?? container.id,
      name: container.name,
      image: container.image,
      status: container.status,
      ports: [],
    } as RuntimeContainer,
  }));
  const [items, setItems] = useState<Array<{ id: string; runtime: RuntimeContainer | null }>>(fallback);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logsBusy, setLogsBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ containers: Array<{ id: string; runtime: RuntimeContainer | null }> }>(
        `/api/instances/${instance.id}/runtime`,
        { cacheTtlMs: false },
      );
      setItems(result.containers);
    } catch {
      setItems(fallback);
    } finally {
      setLoading(false);
    }
  }, [instance.id]);

  useEffect(() => { void load(); }, [load]);

  async function showLogs(id: string) {
    setLogsBusy(id);
    try {
      const result = await api<{ logs: string }>(`/api/instances/${instance.id}/containers/${id}/logs`);
      setLogs((current) => ({ ...current, [id]: result.logs }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLogsBusy(null);
    }
  }

  if (loading) return <PageLoading />;
  if (!items.length) return null;

  return (
    <section className="border-t border-border pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">运行环境</h3>
        <Button size="icon-sm" variant="ghost" onClick={() => void load()} aria-label="刷新运行环境">
          <RefreshCw />
        </Button>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {items.map(({ id, runtime }) => (
          <div key={id} className="space-y-3 py-3">
            <div className="flex items-start gap-3">
              <Container className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-xs">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{runtime?.name ?? id}</span>
                  <Badge variant={runtime?.status === "running" ? "success" : "secondary"}>{runtime?.status ?? "未运行"}</Badge>
                </div>
                <code className="mt-1 block truncate text-[11px] text-muted-foreground">{runtime?.image ?? "—"}</code>
              </div>
              <Button size="sm" variant="ghost" disabled={!runtime || logsBusy === id} onClick={() => void showLogs(id)}>
                {logsBusy === id ? <Loader2 className="animate-spin" /> : <ScrollText />}
                日志
              </Button>
            </div>
            {runtime?.mounts?.length ? (
              <div className="ml-7 space-y-1 text-[11px] text-muted-foreground">
                {runtime.mounts.map((mount) => (
                  <div key={`${mount.source}:${mount.target}`} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <code className="truncate" title={mount.source}>{mount.source}</code>
                    <code className="truncate" title={mount.target}>{mount.target}{mount.mode ? ` · ${mount.mode}` : ""}</code>
                  </div>
                ))}
              </div>
            ) : null}
            {logs[id] ? <pre className="ml-7 max-h-56 overflow-auto whitespace-pre-wrap bg-muted/40 p-2 text-[11px] leading-4">{logs[id]}</pre> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ConfigurationPanel({
  instance,
  onSaved,
}: {
  instance: InstanceDetail;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(instance.name);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(configKeys(instance).map((key) => [key, displayConfigValue(instance.config?.[key])])),
  );
  const [saving, setSaving] = useState(false);
  const keys = configKeys(instance);
  const config = instance.config ?? {};
  const oauthKeys = keys.filter((key) => key.startsWith("oauth"));
  const runtimeKeys = keys.filter((key) => STDIO_CONFIG_KEYS.includes(key));
  const connectionKeys = keys.filter((key) => !oauthKeys.includes(key) && !runtimeKeys.includes(key));

  useEffect(() => {
    setName(instance.name);
    setDraft(Object.fromEntries(configKeys(instance).map((key) => [key, displayConfigValue(instance.config?.[key])] )));
  }, [instance]);

  async function save(restart: boolean) {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of keys) {
        const value = draft[key]?.trim() ?? "";
        if (!value && !(key in config)) continue;
        if (!value && isSecretConfigKey(key) && config[key] === "***") continue;
        if (isJsonConfigKey(key, config[key]) && value) {
          try {
            patch[key] = JSON.parse(value);
          } catch {
            throw new Error(`${CONFIG_LABELS[key] ?? key} 不是有效 JSON`);
          }
        } else {
          patch[key] = isNumericConfigKey(key) ? Number(value) : value;
        }
      }
      await api(`/api/instances/${instance.id}`, { method: "PATCH", json: { name: name.trim(), config: patch } });
      if (restart && instance.status === "running") {
        await api(`/api/instances/${instance.id}/stop`, { method: "POST" });
        await api(`/api/instances/${instance.id}/start`, { method: "POST" });
      }
      toast.success(restart ? "已保存并重启" : "已保存");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
          <Label className="pt-2 text-xs">名称</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        {connectionKeys.length ? (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">连接</h3>
            {connectionKeys.map((key) => <ConfigField key={key} name={key} value={draft[key] ?? ""} original={config[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />)}
          </div>
        ) : null}
        {oauthKeys.length ? (
          <div className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium">OAuth 客户端</h3>
            {oauthKeys.map((key) => <ConfigField key={key} name={key} value={draft[key] ?? ""} original={config[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />)}
          </div>
        ) : null}
        {runtimeKeys.length ? (
          <div className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium">运行参数</h3>
            {runtimeKeys.map((key) => <ConfigField key={key} name={key} value={draft[key] ?? ""} original={config[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />)}
          </div>
        ) : null}
      </section>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button size="sm" variant="outline" disabled={saving || !name.trim()} onClick={() => void save(false)}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
        {instance.status === "running" ? (
          <Button size="sm" disabled={saving || !name.trim()} onClick={() => void save(true)}>
            <RefreshCw />应用并重启
          </Button>
        ) : null}
      </div>
      <RuntimePanel instance={instance} />
    </div>
  );
}

function providerLabel(instance: InstanceDetail) {
  return instance.provider?.name || instance.providerId;
}

function needsUpstreamAuth(i: InstanceDetail): boolean {
  const config = i.config ?? {};
  const hasToken =
    (typeof config.oauthAccessToken === "string" && config.oauthAccessToken.trim().length > 0) ||
    (typeof config.apiToken === "string" && config.apiToken.trim().length > 0) ||
    (typeof config.apiKey === "string" && config.apiKey.trim().length > 0);
  if (hasToken) return false;
  return (
    config.authRequired === true ||
    !!i.lastError?.startsWith("AUTH_REQUIRED") ||
    /missing required Authorization|401|unauthorized/i.test(i.lastError ?? "")
  );
}

/** 远程 HTTP MCP 无本地进程；status 表示平台侧启用 */
function isRemoteMcp(instance: InstanceDetail) {
  return (
    instance.provider?.category === "mcp" &&
    instance.providerId !== "stdio-mcp"
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
}

function statusLabel(instance: InstanceDetail): string {
  const { status } = instance;
  if (isRemoteMcp(instance)) {
    if (status === "running") {
      return "已启用";
    }
    if (status === "starting") return "启用中";
    if (status === "stopping") return "停用中";
    return "未启用";
  }
  if (status === "running") return "运行中";
  if (status === "starting") return "启动中";
  if (status === "stopping") return "停止中";
  if (status === "stopped") return "已停止";
  return status;
}

export default function McpServerDetailPage() {
  return (
    <Suspense
      fallback={<PageLoading />}
    >
      <McpServerDetailInner />
    </Suspense>
  );
}

function McpServerDetailInner() {
  const { confirm: askConfirm } = useConfirmDialog();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = params.id;
  const autoOauth = searchParams.get("oauth") === "1";

  const [instance, setInstance] = useState<InstanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthAutoTried, setOauthAutoTried] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [tab, setTab] = useState("config");
  const oauthUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      oauthUnsubRef.current?.();
    };
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await api<InstanceDetail>(`/api/instances/${id}`, {
          cacheTtlMs: false,
        });
        setInstance(data);
      } catch (err) {
        if (!silent) {
          toast.error(err instanceof Error ? err.message : String(err));
          setInstance(null);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 本实例的状态/安装进度经平台事件推送，变化时静默重拉详情
  useEffect(() => {
    let last = 0;
    return subscribePlatformEvents((ev) => {
      if (
        (ev.type !== "mcp_instance" && ev.type !== "mcp_progress") ||
        ev.instanceId !== id
      ) {
        return;
      }
      const now = Date.now();
      if (ev.type === "mcp_progress" && now - last < 2000) return;
      last = now;
      void load(true);
    });
  }, [id, load]);

  useEffect(() => {
    if (!autoOauth || oauthAutoTried || loading || !instance) return;
    setOauthAutoTried(true);
    void startUpstreamOauth();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-trigger once on oauth=1
  }, [autoOauth, oauthAutoTried, loading, instance]);

  async function startStop(action: "start" | "stop") {
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}/${action}`, { method: "POST" });
      const remote = instance ? isRemoteMcp(instance) : false;
      toast.success(
        action === "start"
          ? remote
            ? "已启用"
            : "已启动"
          : remote
            ? "已停用"
            : "已停止",
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function removeInstance() {
    if (!(await askConfirm({ title: "删除该 MCP 服务器？", description: "已绑定的 Agent 将无法再使用它。", confirmLabel: "删除服务器" }))) return;
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}`, { method: "DELETE" });
      toast.success("已删除");
      router.back();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setActionBusy(false);
    }
  }

  async function setToolPermission(ruleId: string, enabled: boolean) {
    if (!instance) return;
    setActionBusy(true);
    try {
      const prev =
        instance.config?.toolPermissions &&
        typeof instance.config.toolPermissions === "object" &&
        !Array.isArray(instance.config.toolPermissions)
          ? { ...(instance.config.toolPermissions as Record<string, boolean>) }
          : {};
      await api(`/api/instances/${id}`, {
        method: "PATCH",
        json: {
          config: {
            toolPermissions: { ...prev, [ruleId]: enabled },
          },
        },
      });
      toast.success(enabled ? `已开启 ${ruleId}` : `已关闭 ${ruleId}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function startUpstreamOauth() {
    setOauthBusy(true);
    const preparedTab = prepareOauthTab();
    try {
      const { authorizeUrl } = await startUpstreamOauthApi(id);
      navigateOauthTab(preparedTab, authorizeUrl);
      toast.message("已打开授权窗口", {
        description: "在弹出窗口完成授权后将自动刷新",
      });
      oauthUnsubRef.current?.();
      oauthUnsubRef.current = listenMcpOauthCallback((msg) => {
        if (msg.ok) {
          toast.success("OAuth 授权成功");
          void load();
        } else {
          toast.error(msg.error || "OAuth 授权失败");
        }
        setOauthBusy(false);
      });
    } catch (err) {
      if (preparedTab && !preparedTab.closed) preparedTab.close();
      toast.error(err instanceof Error ? err.message : String(err));
      setOauthBusy(false);
    }
  }

  if (loading && !instance) {
    return <PageLoading />;
  }

  if (!instance) {
    return (
      <div className="space-y-5 py-16 text-center">
        <p className="text-sm text-muted-foreground">未找到该 MCP 服务器</p>
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          <ArrowLeft />
          返回
        </Button>
      </div>
    );
  }

  const tools = instance.tools ?? [];
  const resources = instance.resources ?? [];
  const prompts = instance.prompts ?? [];
  const templates = instance.resourceTemplates ?? [];
  const authNeeded = needsUpstreamAuth(instance);
  const remoteUrl =
    typeof instance.config?.mcpUrl === "string"
      ? instance.config.mcpUrl
      : instance.endpointUrl;
  const emptyHint =
    instance.status !== "running" ? "启动服务器后可加载" : undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground"
          onClick={() => router.back()}
        >
          <ArrowLeft className="size-3.5" />
          返回
        </Button>
      </div>

      <SettingsHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {instance.name}
            <code className="text-[11px] font-normal text-muted-foreground">{instance.slug}</code>
            <Badge variant="outline">{providerLabel(instance)}</Badge>
            <Badge
              variant={statusVariant(instance.status)}
              title={
                isRemoteMcp(instance)
                  ? "远程 MCP 无本地进程；此状态表示是否已在平台启用（使用时会自动启用）"
                  : undefined
              }
            >
              {statusLabel(instance)}
            </Badge>
            {authNeeded ? <Badge variant="destructive">需 OAuth</Badge> : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-1.5">
            {instance.status === "running" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => void startStop("stop")}
              >
                {isRemoteMcp(instance) ? "停用" : "停止"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => void startStop("start")}
              >
                {isRemoteMcp(instance) ? "启用" : "启动"}
              </Button>
            )}
            {instance.provider?.category === "mcp" ? (
              <Button
                size="sm"
                variant={authNeeded ? "default" : "outline"}
                disabled={oauthBusy}
                onClick={() => void startUpstreamOauth()}
              >
                <KeyRound className="size-3.5" />
                {authNeeded ? "去授权" : "OAuth"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy}
              onClick={() => void removeInstance()}
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          </div>
        }
      />

      <div className="grid gap-3">
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-[11px] text-muted-foreground">上游地址</div>
          <code className="mt-1 block break-all font-mono text-[11px]">
            {remoteUrl || "—"}
          </code>
        </div>
      </div>

      {instance.lastError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3.5 py-3 text-xs text-destructive">
          {instance.lastError}
        </div>
      ) : null}

      {instance.toolPermissions && instance.toolPermissions.length > 0 ? (
        <McpToolPermissionsPanel
          rules={instance.toolPermissions}
          disabled={actionBusy}
          onChange={(ruleId, enabled) => void setToolPermission(ruleId, enabled)}
        />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v) setTab(v);
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="tools">工具 · {tools.length}</TabsTrigger>
          <TabsTrigger value="resources">资源 · {resources.length}</TabsTrigger>
          <TabsTrigger value="prompts">Prompts · {prompts.length}</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-5">
          <ConfigurationPanel instance={instance} onSaved={() => load()} />
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          <McpToolsExplorer
            tools={tools}
            emptyHint={emptyHint ?? "暂无 tools"}
          />
        </TabsContent>

        <TabsContent value="resources" className="mt-4">
          <McpResourcesExplorer
            resources={resources}
            templates={templates}
            emptyHint={emptyHint ?? "暂无 resources"}
          />
        </TabsContent>

        <TabsContent value="prompts" className="mt-4">
          <McpPromptsExplorer
            prompts={prompts}
            emptyHint={emptyHint ?? "暂无 prompts"}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
