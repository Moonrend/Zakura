"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  HeartPulse,
  KeyRound,
  Play,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  listenMcpOauthCallback,
  navigateOauthTab,
  prepareOauthTab,
  startUpstreamOauth as startUpstreamOauthApi,
} from "@/lib/mcp-oauth";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  SchemaToolForm,
  defaultsFromSchema,
} from "@/components/mcp/schema-tool-form";
import { McpToolPermissionsPanel } from "@/components/mcp/tool-permissions-panel";
import type { McpToolPermissionState } from "@/lib/mcp-config";
import { cn } from "@/lib/utils";

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
  tools?: ToolRow[];
  toolPermissions?: McpToolPermissionState[];
};

type ToolRow = {
  qualifiedName: string;
  description: string;
  providerId: string;
  inputSchema?: Record<string, unknown>;
  instanceId?: string | null;
  localName?: string;
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

function statusVariant(
  status: string,
): "default" | "secondary" | "success" | "warn" | "danger" {
  if (status === "running") return "success";
  if (status === "starting" || status === "stopping") return "warn";
  if (status === "error" || status === "unhealthy") return "danger";
  return "secondary";
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
  const [selectedTool, setSelectedTool] = useState<ToolRow | null>(null);
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [resultText, setResultText] = useState("");
  const [calling, setCalling] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthAutoTried, setOauthAutoTried] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const oauthUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      oauthUnsubRef.current?.();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<InstanceDetail>(`/api/instances/${id}`);
      setInstance(data);
      setSelectedTool((prev) => {
        if (!prev || !data.tools?.length) return prev;
        return data.tools.find((t) => t.qualifiedName === prev.qualifiedName) ?? prev;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setInstance(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoOauth || oauthAutoTried || loading || !instance) return;
    if (instance.providerId !== "generic-mcp") return;
    setOauthAutoTried(true);
    void startUpstreamOauth();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-trigger once on oauth=1
  }, [autoOauth, oauthAutoTried, loading, instance]);

  function selectTool(tool: ToolRow) {
    setSelectedTool(tool);
    setArgs(defaultsFromSchema(tool.inputSchema ?? {}));
    setResultText("");
  }

  async function runTool() {
    if (!selectedTool) return;
    setCalling(true);
    setResultText("");
    try {
      const res = await api<{
        ok: boolean;
        result: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      }>("/api/mcp/call", {
        method: "POST",
        json: {
          qualifiedName: selectedTool.qualifiedName,
          arguments: args,
        },
      });
      const text =
        res.result.content
          ?.map((c) => ("text" in c ? c.text : JSON.stringify(c)))
          .join("\n") ?? JSON.stringify(res.result, null, 2);
      setResultText(text);
      if (res.result.isError) toast.error("调用返回错误");
      else toast.success("调用成功");
    } catch (err) {
      setResultText(err instanceof Error ? err.message : String(err));
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  }

  async function startStop(action: "start" | "stop") {
    setActionBusy(true);
    try {
      await api(`/api/instances/${id}/${action}`, { method: "POST" });
      toast.success(action === "start" ? "已启动" : "已停止");
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
  const authNeeded = needsUpstreamAuth(instance);
  const remoteUrl =
    typeof instance.config?.mcpUrl === "string"
      ? instance.config.mcpUrl
      : instance.endpointUrl;

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
            <Badge variant={statusVariant(instance.status)}>{instance.status}</Badge>
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
                停止
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => void startStop("start")}
              >
                启动
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

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">工具 · {tools.length}</h2>
          </div>
          <div className="max-h-[520px] overflow-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tools.map((t) => (
                  <TableRow
                    key={t.qualifiedName}
                    className={cn(
                      "cursor-pointer",
                      selectedTool?.qualifiedName === t.qualifiedName
                        ? "bg-muted/50"
                        : "hover:bg-muted/30",
                    )}
                    onClick={() => selectTool(t)}
                  >
                    <TableCell>
                      <code className="text-[11px]">{t.localName ?? t.qualifiedName}</code>
                      <div className="mt-0.5 max-w-[280px] truncate text-[10px] text-muted-foreground">
                        {t.description}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && !tools.length ? (
                  <TableRow>
                    <TableCell className="py-10 text-center text-muted-foreground">
                      {instance.status !== "running"
                        ? "启动服务器后可加载工具"
                        : "暂无 tools"}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">工具试用</h2>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            {selectedTool ? (
              <>
                <div>
                  <code className="text-xs">{selectedTool.qualifiedName}</code>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedTool.description}
                  </p>
                </div>
                <SchemaToolForm
                  schema={selectedTool.inputSchema ?? { type: "object", properties: {} }}
                  value={args}
                  onChange={setArgs}
                />
                <Button disabled={calling} onClick={() => void runTool()}>
                  <Play />
                  {calling ? "调用中…" : "运行"}
                </Button>
                {resultText ? (
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] whitespace-pre-wrap">
                    {resultText}
                  </pre>
                ) : null}
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                选择左侧工具，按 schema 生成表单后试用。
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
