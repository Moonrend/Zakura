"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { CloudDownload, RefreshCw, Save, Store } from "lucide-react";
import {
  fetchAgent,
  fetchAgentProviders,
  saveAgentProviders,
  statusVariant,
  type AgentDetail,
  type AgentProviderOptions,
} from "@/lib/agents";
import {
  McpPromptsExplorer,
  McpResourcesExplorer,
  McpToolsExplorer,
} from "@/components/mcp/capability-explorers";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

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

export default function AgentMcpPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [mode, setMode] = useState<"all" | "selected">("selected");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exposeFs, setExposeFs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [capsBusy, setCapsBusy] = useState(false);
  const [tab, setTab] = useState("bindings");

  const loadBindings = useCallback(async () => {
    try {
      const p = await fetchAgentProviders(id);
      setOpts(p);
      setMode(p.mcp.mode);
      setExposeFs(p.mcp.exposeWorkspaceFs !== false);
      setSelected(new Set(p.mcp.instances.filter((i) => i.bound).map((i) => i.id)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const loadCapabilities = useCallback(async () => {
    setCapsBusy(true);
    try {
      const d = await fetchAgent(id);
      setDetail(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCapsBusy(false);
    }
  }, [id]);

  useEffect(() => {
    void loadBindings();
  }, [loadBindings]);

  useEffect(() => {
    if (tab !== "bindings" && !detail) {
      void loadCapabilities();
    }
  }, [tab, detail, loadCapabilities]);

  function toggleInstance(instanceId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  }

  async function saveBindings() {
    setBusy(true);
    try {
      const res = await saveAgentProviders(id, {
        mcp: {
          mode,
          instanceIds: mode === "selected" ? [...selected] : undefined,
          exposeWorkspaceFs: exposeFs,
        },
      });
      setOpts(res.options);
      setMode(res.options.mcp.mode);
      setExposeFs(res.options.mcp.exposeWorkspaceFs !== false);
      setSelected(
        new Set(res.options.mcp.instances.filter((i) => i.bound).map((i) => i.id)),
      );
      setDetail(null);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!opts) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  const instances = opts.mcp.instances;
  const tools =
    detail?.tools.map((t) => ({
      qualifiedName: t.name,
      description: t.description,
      providerId: t.providerId,
      inputSchema: t.inputSchema,
      agentScoped: t.agentScoped,
    })) ?? [];
  const resources = detail?.resources ?? [];
  const prompts = detail?.prompts ?? [];
  const templates = detail?.resourceTemplates ?? [];

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="MCP"
        actions={
          <>
            {tab === "bindings" ? (
              <>
                <Select
                  value={mode}
                  onValueChange={(v) => {
                    if (v != null) setMode(v as "all" | "selected");
                  }}
                  items={[
                    { value: "all", label: "全部 running" },
                    { value: "selected", label: "仅所选" },
                  ]}
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部 running</SelectItem>
                    <SelectItem value="selected">仅所选</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/store" />}
                >
                  <Store />
                  商店
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/import" />}
                >
                  <CloudDownload />
                  导入
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void saveBindings()}>
                  <Save />
                  保存
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={capsBusy}
                onClick={() => void loadCapabilities()}
              >
                <RefreshCw className={capsBusy ? "animate-spin" : undefined} />
                刷新能力
              </Button>
            )}
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v) setTab(v);
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="bindings">绑定</TabsTrigger>
          <TabsTrigger value="tools">工具{detail ? ` · ${tools.length}` : ""}</TabsTrigger>
          <TabsTrigger value="resources">
            资源
            {detail
              ? ` · ${resources.length}${templates.length ? ` / 模板 ${templates.length}` : ""}`
              : ""}
          </TabsTrigger>
          <TabsTrigger value="prompts">
            Prompts{detail ? ` · ${prompts.length}` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bindings" className="mt-4 space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">暴露云端文件系统</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                默认开启。MCP Resources 列出工作区顶层文件；Resource Templates 提供{" "}
                <code className="text-[11px]">zakura://agent/fs/{"{+path}"}</code>{" "}
                按需读取任意路径。与「资源 / 资源模板」是两种能力：前者可枚举，后者需填参。
              </p>
            </div>
            <Switch checked={exposeFs} onCheckedChange={setExposeFs} />
          </div>

          {instances.length === 0 ? (
            <div className="rounded-lg border border-dashed py-12 text-center">
              <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 实例</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" nativeButton={false} render={<Link href="/dashboard/mcp/store" />}>
                  <Store />
                  商店
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/import" />}
                >
                  <CloudDownload />
                  导入
                </Button>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">绑定</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((inst) => {
                  const bound = mode === "all" ? true : selected.has(inst.id);
                  return (
                    <TableRow key={inst.id}>
                      <TableCell>
                        <Link
                          href={`/dashboard/mcp/${inst.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {inst.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <code className="text-[11px] text-muted-foreground">{inst.slug}</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{providerLabel(inst.providerId)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(inst.status)}>{inst.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch
                          checked={bound}
                          disabled={mode === "all"}
                          onCheckedChange={(v) => toggleInstance(inst.id, v)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {mode === "all" && instances.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              当前为「全部 running」模式：自动挂载所有运行中的实例，无需逐个勾选。
            </p>
          ) : null}
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          {capsBusy && !detail ? (
            <Skeleton className="h-64 w-full rounded-lg" />
          ) : (
            <McpToolsExplorer
              tools={tools}
              agentId={id}
              emptyHint="当前绑定下暂无聚合工具（请确认实例运行中）"
            />
          )}
        </TabsContent>

        <TabsContent value="resources" className="mt-4">
          {capsBusy && !detail ? (
            <Skeleton className="h-64 w-full rounded-lg" />
          ) : (
            <McpResourcesExplorer
              resources={resources}
              templates={templates}
              agentId={id}
              emptyHint="当前绑定下暂无资源"
            />
          )}
        </TabsContent>

        <TabsContent value="prompts" className="mt-4">
          {capsBusy && !detail ? (
            <Skeleton className="h-64 w-full rounded-lg" />
          ) : (
            <McpPromptsExplorer
              prompts={prompts}
              agentId={id}
              emptyHint="当前绑定下暂无 Prompts"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
