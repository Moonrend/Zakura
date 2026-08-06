"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { CloudDownload, RefreshCw, Store } from "lucide-react";
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
import {
  SettingsHeader,
  SettingsRow,
  SettingsSaveIndicator,
  SettingsSection,
} from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
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
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

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

type McpBindingState = {
  mode: "all" | "selected";
  selected: string[];
  exposeFs: boolean;
};

export default function AgentMcpPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<McpBindingState | null>(null);
  const [capsBusy, setCapsBusy] = useState(false);
  const [tab, setTab] = useState("bindings");
  const selectedRef = useRef<string[]>([]);

  const loadBindings = useCallback(async () => {
    try {
      const p = await fetchAgentProviders(id);
      setOpts(p);
      const selected = p.mcp.instances.filter((i) => i.bound).map((i) => i.id);
      selectedRef.current = selected;
      setState({
        mode: p.mcp.mode,
        selected,
        exposeFs: p.mcp.exposeWorkspaceFs !== false,
      });
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

  const persist = useCallback(
    async (patch: Partial<McpBindingState>) => {
      const mode = patch.mode ?? state?.mode ?? "selected";
      const selected = patch.selected ?? selectedRef.current;
      const exposeFs = patch.exposeFs ?? state?.exposeFs ?? true;
      const res = await saveAgentProviders(id, {
        mcp: {
          mode,
          instanceIds: mode === "selected" ? selected : undefined,
          exposeWorkspaceFs: exposeFs,
        },
      });
      setOpts(res.options);
      const nextSelected = res.options.mcp.instances
        .filter((i) => i.bound)
        .map((i) => i.id);
      selectedRef.current = nextSelected;
      setState({
        mode: res.options.mcp.mode,
        selected: nextSelected,
        exposeFs: res.options.mcp.exposeWorkspaceFs !== false,
      });
      setDetail(null);
    },
    [id, state?.mode, state?.exposeFs],
  );

  const { status, error, saveNow } = useAutoSave(persist);

  function setMode(mode: "all" | "selected") {
    setState((prev) => (prev ? { ...prev, mode } : prev));
    saveNow({ mode });
  }

  function setExposeFs(exposeFs: boolean) {
    setState((prev) => (prev ? { ...prev, exposeFs } : prev));
    saveNow({ exposeFs });
  }

  function toggleInstance(instanceId: string, on: boolean) {
    setState((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.selected);
      if (on) set.add(instanceId);
      else set.delete(instanceId);
      const selected = [...set];
      selectedRef.current = selected;
      saveNow({ selected, mode: "selected" });
      return { ...prev, selected, mode: "selected" };
    });
  }

  if (!opts || !state) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  const instances = opts.mcp.instances;
  const selectedSet = new Set(state.selected);
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
                <SettingsSaveIndicator status={status} error={error} />
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
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={capsBusy}
                onClick={() => void loadCapabilities()}
              >
                <RefreshCw className={capsBusy ? "animate-spin" : undefined} />
                刷新
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
          <TabsTrigger value="tools">
            工具{detail ? ` · ${tools.length}` : ""}
          </TabsTrigger>
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
          <SettingsSection>
            <SettingsRow label="暴露工作区文件" htmlFor="mcp-expose-fs">
              <Switch
                id="mcp-expose-fs"
                checked={state.exposeFs}
                onCheckedChange={(v) => setExposeFs(Boolean(v))}
              />
            </SettingsRow>
            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
              <div className="text-sm font-medium">挂载模式</div>
              <Select
                value={state.mode}
                onValueChange={(v) => {
                  if (v === "all" || v === "selected") setMode(v);
                }}
                items={[
                  { value: "all", label: "全部" },
                  { value: "selected", label: "仅所选" },
                ]}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="selected">仅所选</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingsSection>

          {instances.length === 0 ? (
            <div className="rounded-lg border border-dashed py-12 text-center">
              <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 实例</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
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
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                    const bound =
                      state.mode === "all" ? true : selectedSet.has(inst.id);
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
                          <code className="text-[11px] text-muted-foreground">
                            {inst.slug}
                          </code>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {providerLabel(inst.providerId)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(inst.status)}>
                            {inst.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={bound}
                            disabled={state.mode === "all"}
                            onCheckedChange={(v) =>
                              toggleInstance(inst.id, Boolean(v))
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

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
