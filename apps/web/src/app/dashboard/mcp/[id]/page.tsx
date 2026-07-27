"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  HeartPulse,
  KeyRound,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { McpToolPermissionsPanel } from "@/components/mcp/tool-permissions-panel";
import type { McpToolPermissionState } from "@/lib/mcp-config";

type InstanceDetail = {
  id: string;
  name: string;
  slug: string;
  providerId: string;
  status: string;
  healthStatus: string;
  endpointUrl?: string | null;
  lastError?: string | null;
  config?: Record<string, unknown>;
  tools?: McpToolRow[];
  resources?: McpResourceRow[];
  prompts?: McpPromptRow[];
  resourceTemplates?: McpResourceTemplateRow[];
  toolPermissions?: McpToolPermissionState[];
};

function providerLabel(id: string) {
  switch (id) {
    case "generic-mcp":
      return "HTTP";
    case "stdio-mcp":
      return "Stdio";
    case "openviking":
      return "OpenViking";
    default:
      return id;
  }
}

function needsUpstreamAuth(i: InstanceDetail): boolean {
  return (
    !!i.lastError?.startsWith("AUTH_REQUIRED") ||
    /missing required Authorization|401|unauthorized/i.test(i.lastError ?? "")
  );
}

/** 远程 HTTP MCP 无本地进程；status 表示平台侧启用 */
function isRemoteMcp(providerId: string) {
  return providerId === "generic-mcp" || providerId === "google-workspace";
}

function statusVariant(
  status: string,
  healthStatus?: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running" && healthStatus === "unhealthy") return "danger";
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
}

function statusLabel(status: string, providerId: string, healthStatus?: string): string {
  if (isRemoteMcp(providerId)) {
    if (status === "running") {
      if (healthStatus === "unhealthy") return "不可用";
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
      fallback={
        <div className="space-y-5">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      }
    >
      <McpServerDetailInner />
    </Suspense>
  );
}

function McpServerDetailInner() {
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
  const [tab, setTab] = useState("tools");
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
    if (instance.providerId !== "generic-mcp") return;
    setOauthAutoTried(true);
    void startUpstreamOauth();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-trigger once on oauth=1
  }, [autoOauth, oauthAutoTried, loading, instance]);

  async function startStop(action: "start" | "stop") {
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}/${action}`, { method: "POST" });
      const remote = instance ? isRemoteMcp(instance.providerId) : false;
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

  async function refreshHealth() {
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}/health`, { method: "POST" });
      toast.success("已重新检查");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function removeInstance() {
    if (!confirm("删除该 MCP 服务器？已绑定的 Agent 将无法再使用它。")) return;
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}`, { method: "DELETE" });
      toast.success("已删除");
      router.push("/dashboard/mcp");
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
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-80 rounded-lg" />
          <Skeleton className="h-80 rounded-lg" />
        </div>
      </div>
    );
  }

  if (!instance) {
    return (
      <div className="space-y-5 py-16 text-center">
        <p className="text-sm text-muted-foreground">未找到该 MCP 服务器</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/mcp" />}>
          <ArrowLeft />
          返回列表
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
          nativeButton={false}
          render={<Link href="/dashboard/mcp" />}
        >
          <ArrowLeft className="size-3.5" />
          MCP 服务器
        </Button>
      </div>

      <SettingsHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {instance.name}
            <code className="text-[11px] font-normal text-muted-foreground">{instance.slug}</code>
            <Badge variant="outline">{providerLabel(instance.providerId)}</Badge>
            <Badge
              variant={statusVariant(instance.status, instance.healthStatus)}
              title={
                isRemoteMcp(instance.providerId)
                  ? "远程 MCP 无本地进程；此状态表示是否已在平台启用（使用时会自动启用）"
                  : undefined
              }
            >
              {statusLabel(instance.status, instance.providerId, instance.healthStatus)}
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
                {isRemoteMcp(instance.providerId) ? "停用" : "停止"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => void startStop("start")}
              >
                {isRemoteMcp(instance.providerId) ? "启用" : "启动"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy}
              onClick={() => void refreshHealth()}
            >
              <HeartPulse className="size-3.5" />
              健康检查
            </Button>
            {instance.providerId === "generic-mcp" ||
            instance.providerId === "google-workspace" ? (
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

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-3.5">
          <div className="text-[11px] text-muted-foreground">健康状态</div>
          <div className="mt-1 text-sm font-medium">{instance.healthStatus || "—"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3.5 sm:col-span-2">
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
          <TabsTrigger value="tools">工具 · {tools.length}</TabsTrigger>
          <TabsTrigger value="resources">资源 · {resources.length}</TabsTrigger>
          <TabsTrigger value="prompts">Prompts · {prompts.length}</TabsTrigger>
        </TabsList>

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
