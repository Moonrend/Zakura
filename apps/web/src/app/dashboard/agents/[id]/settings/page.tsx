"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  fetchAgentProviders,
  saveAgentProviders,
  type AgentProviderOptions,
} from "@/lib/agents";
import {
  getCloudConfig,
  listChatModels,
  saveCloudConfig,
  type ChatModelOption,
} from "@/lib/cloud-agent";
import type { CloudAgentConfig } from "@zakura/shared";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import {
  SettingsCategoryNav,
  SettingsHeader,
  SettingsRow,
  SettingsSaveIndicator,
  SettingsSection,
} from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SETTINGS_CATEGORIES = [
  { id: "basic", label: "基本" },
  { id: "capabilities", label: "能力" },
  { id: "behavior", label: "对话" },
  { id: "subagent", label: "子代理" },
  { id: "danger", label: "危险区" },
] as const;

type CategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

type LocalState = {
  name: string;
  description: string;
  enableMemory: boolean;
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  exposeWorkspaceFs: boolean;
  systemPrompt: string;
  model: string;
  modelRouteId: string | null;
  enableTools: boolean;
  autoMemory: boolean;
  autoTitle: boolean;
  maxToolRounds: string;
  maxSubagentDepth: string;
};

const DEPTH_ITEMS = [
  { value: "1", label: "1" },
  { value: "2", label: "2（默认）" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5" },
];

function cloudToLocal(cloud: CloudAgentConfig): Pick<
  LocalState,
  | "systemPrompt"
  | "model"
  | "modelRouteId"
  | "enableTools"
  | "autoMemory"
  | "autoTitle"
  | "maxToolRounds"
  | "maxSubagentDepth"
> {
  return {
    systemPrompt: cloud.systemPrompt ?? "",
    model: cloud.model ?? "",
    modelRouteId: cloud.modelRouteId ?? null,
    enableTools: cloud.enableTools !== false,
    autoMemory: cloud.autoMemory !== false,
    autoTitle: cloud.autoTitle !== false,
    maxToolRounds:
      cloud.maxToolRounds != null && cloud.maxToolRounds > 0
        ? String(cloud.maxToolRounds)
        : "",
    maxSubagentDepth: String(cloud.maxSubagentDepth ?? 2),
  };
}

export default function AgentSettingsPage() {
  const router = useRouter();
  const { id, agent, refresh, patchAgent } = useAgentDetail();
  const { confirm } = useConfirmDialog();
  const [ready, setReady] = useState(false);
  const [activeCat, setActiveCat] = useState<CategoryId>("basic");
  const [providers, setProviders] = useState<AgentProviderOptions | null>(null);
  const [state, setState] = useState<LocalState | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, opts, cfg, models] = await Promise.all([
        refresh({ list: false }),
        fetchAgentProviders(id),
        getCloudConfig(id),
        listChatModels(),
      ]);
      if (!detail) return;
      setProviders(opts);
      setChatModels(models);
      const cloudLocal = cloudToLocal(cfg.cloud);
      setState({
        name: detail.name,
        description: detail.description ?? "",
        enableMemory: detail.enableMemory,
        webSearchEnabled: opts.webSearch.agent.enabled,
        webFetchEnabled: opts.webFetch.agent.enabled,
        exposeWorkspaceFs: opts.mcp.exposeWorkspaceFs !== false,
        ...cloudLocal,
      });
      setReady(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id, refresh]);

  useEffect(() => {
    setReady(false);
    setState(null);
    void load();
  }, [load]);

  type SavePatch = {
    name?: string;
    description?: string;
    enableMemory?: boolean;
    webSearchEnabled?: boolean;
    webFetchEnabled?: boolean;
    exposeWorkspaceFs?: boolean;
    systemPrompt?: string;
    model?: string;
    modelRouteId?: string | null;
    enableTools?: boolean;
    autoMemory?: boolean;
    autoTitle?: boolean;
    maxToolRounds?: string;
    maxSubagentDepth?: string;
  };

  const persist = useCallback(
    async (patch: SavePatch) => {
      const agentPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) agentPatch.name = patch.name.trim() || undefined;
      if (patch.description !== undefined) agentPatch.description = patch.description;
      if (patch.enableMemory !== undefined) agentPatch.enableMemory = patch.enableMemory;

      if (Object.keys(agentPatch).length > 0) {
        await api(`/api/agents/${id}`, {
          method: "PATCH",
          json: agentPatch,
        });
        patchAgent({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          ...(patch.enableMemory !== undefined
            ? { enableMemory: patch.enableMemory }
            : {}),
        });
      }

      const providerPatch: Parameters<typeof saveAgentProviders>[1] = {};
      if (patch.webSearchEnabled !== undefined) {
        providerPatch.webSearch = { enabled: patch.webSearchEnabled };
      }
      if (patch.webFetchEnabled !== undefined) {
        providerPatch.webFetch = { enabled: patch.webFetchEnabled };
      }
      if (patch.exposeWorkspaceFs !== undefined) {
        providerPatch.mcp = { exposeWorkspaceFs: patch.exposeWorkspaceFs };
      }
      if (Object.keys(providerPatch).length > 0) {
        const res = await saveAgentProviders(id, providerPatch);
        setProviders(res.options);
      }

      const cloudPatch: Parameters<typeof saveCloudConfig>[1] = {};
      if (patch.systemPrompt !== undefined) cloudPatch.systemPrompt = patch.systemPrompt;
      if (patch.model !== undefined) cloudPatch.model = patch.model || null;
      if (patch.modelRouteId !== undefined) {
        cloudPatch.modelRouteId = patch.modelRouteId || null;
      }
      if (patch.enableTools !== undefined) cloudPatch.enableTools = patch.enableTools;
      if (patch.autoMemory !== undefined) cloudPatch.autoMemory = patch.autoMemory;
      if (patch.autoTitle !== undefined) cloudPatch.autoTitle = patch.autoTitle;
      if (patch.maxToolRounds !== undefined) {
        const n = Number(patch.maxToolRounds);
        cloudPatch.maxToolRounds =
          patch.maxToolRounds.trim() === "" || !Number.isFinite(n) || n <= 0
            ? null
            : Math.floor(n);
      }
      if (patch.maxSubagentDepth !== undefined) {
        const n = Number(patch.maxSubagentDepth);
        cloudPatch.maxSubagentDepth =
          Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 5) : null;
      }
      if (Object.keys(cloudPatch).length > 0) {
        await saveCloudConfig(id, cloudPatch);
      }
    },
    [id, patchAgent],
  );

  const { status, error, schedule, saveNow } = useAutoSave(persist, {
    debounceMs: 550,
  });

  const setField = useCallback(
    <K extends keyof LocalState>(key: K, value: LocalState[K], immediate = false) => {
      setState((prev) => (prev ? { ...prev, [key]: value } : prev));
      const patch = { [key]: value } as SavePatch;
      if (immediate) saveNow(patch);
      else schedule(patch);
    },
    [schedule, saveNow],
  );

  const categoryItems = useMemo(
    () => SETTINGS_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
    [],
  );

  const modelItems = useMemo<ModelRouteSelectorItem[]>(() => {
    const items = chatModels.map((m) => ({
      value: m.alias,
      label: m.name,
      hint: m.upstream,
      keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
      providers: m.providers,
    }));
    if (state?.model && !chatModels.some((m) => m.alias === state.model)) {
      items.push({
        value: state.model,
        label: state.model,
        hint: undefined,
        keywords: [],
        providers: [],
      });
    }
    return items;
  }, [chatModels, state?.model]);

  const displayModel =
    state?.model ||
    chatModels.find((m) => m.isDefault)?.alias ||
    chatModels[0]?.alias ||
    "";

  async function removeAgent() {
    if (!agent) return;
    if (
      !(await confirm({
        title: `删除 ${agent.name}？`,
        description: "删除后将无法恢复该 Agent。",
        confirmLabel: "删除",
      }))
    ) {
      return;
    }
    const purge = await confirm({
      title: "同时清除工作区数据？",
      description: "选择确定将一并删除该 Agent 的工作区数据。",
      confirmLabel: "清除并删除",
    });
    setDeleting(true);
    try {
      await api(`/api/agents/${id}?purge=${purge ? "1" : "0"}`, {
        method: "DELETE",
      });
      toast.success("已删除");
      router.replace("/dashboard/agents");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  if (!agent || !state || !ready) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-5 md:grid-cols-[9rem_1fr]">
          <Skeleton className="hidden h-48 md:block" />
          <div className="space-y-4">
            <Skeleton className="h-36 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="设置"
        description="名称、能力开关、对话行为与危险操作"
        actions={<SettingsSaveIndicator status={status} error={error} />}
      />

      <div className="grid gap-5 md:grid-cols-[9rem_minmax(0,1fr)] md:items-start">
        <SettingsCategoryNav
          className="md:sticky md:top-4"
          items={categoryItems}
          activeId={activeCat}
          onSelect={(cid) => setActiveCat(cid as CategoryId)}
        />

        <div className="min-w-0 space-y-4">
          <SettingsSection id="settings-basic" title="基本">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="agent-name" className="text-sm font-medium">
                  名称
                </label>
                <Input
                  id="agent-name"
                  value={state.name}
                  onChange={(e) => setField("name", e.target.value)}
                  onBlur={() => {
                    if (state.name.trim() !== agent.name) {
                      saveNow({ name: state.name });
                    }
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="agent-desc" className="text-sm font-medium">
                  描述
                </label>
                <Textarea
                  id="agent-desc"
                  value={state.description}
                  rows={2}
                  onChange={(e) => setField("description", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Slug</label>
                <code className="block rounded-md border border-border/80 bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                  {agent.slug}
                </code>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="settings-capabilities" title="能力">
            <SettingsRow label="记忆" htmlFor="cap-memory">
              <Switch
                id="cap-memory"
                checked={state.enableMemory}
                onCheckedChange={(v) => setField("enableMemory", Boolean(v), true)}
              />
            </SettingsRow>
            <Separator />
            <SettingsRow label="网页搜索" htmlFor="cap-search">
              <Switch
                id="cap-search"
                checked={state.webSearchEnabled}
                disabled={!providers?.webSearch.engines.length}
                onCheckedChange={(v) =>
                  setField("webSearchEnabled", Boolean(v), true)
                }
              />
            </SettingsRow>
            <Separator />
            <SettingsRow label="网页抓取" htmlFor="cap-fetch">
              <Switch
                id="cap-fetch"
                checked={state.webFetchEnabled}
                disabled={!providers?.webFetch.backends.length}
                onCheckedChange={(v) =>
                  setField("webFetchEnabled", Boolean(v), true)
                }
              />
            </SettingsRow>
            <Separator />
            <SettingsRow label="暴露工作区文件" htmlFor="cap-expose-fs">
              <Switch
                id="cap-expose-fs"
                checked={state.exposeWorkspaceFs}
                onCheckedChange={(v) =>
                  setField("exposeWorkspaceFs", Boolean(v), true)
                }
              />
            </SettingsRow>
            <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/dashboard/agents/${id}/memory`} />}
              >
                记忆
              </Button>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/dashboard/agents/${id}/web`} />}
              >
                网页
              </Button>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/dashboard/agents/${id}/mcp`} />}
              >
                MCP
              </Button>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/dashboard/agents/${id}/computer`} />}
              >
                电脑
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection id="settings-behavior" title="对话">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">模型</label>
                <p className="text-xs text-muted-foreground">
                  未选择时使用团队默认对话模型；多上游可选「自动」动态路由。
                </p>
                <ModelRouteSelector
                  items={modelItems}
                  value={displayModel}
                  routeId={state.modelRouteId}
                  onSelectionChange={(alias, routeId) => {
                    if (!alias) return;
                    setState((prev) =>
                      prev ? { ...prev, model: alias, modelRouteId: routeId } : prev,
                    );
                    saveNow({ model: alias, modelRouteId: routeId });
                  }}
                  disabled={chatModels.length === 0}
                  placeholder={chatModels.length === 0 ? "暂无模型" : "选择模型"}
                  className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
                />
              </div>
              <Separator />
              <div className="space-y-1.5">
                <label htmlFor="system-prompt" className="text-sm font-medium">
                  系统提示词
                </label>
                <Textarea
                  id="system-prompt"
                  value={state.systemPrompt}
                  rows={5}
                  onChange={(e) => setField("systemPrompt", e.target.value)}
                />
              </div>
              <Separator />
              <SettingsRow label="工具调用" htmlFor="behave-tools">
                <Switch
                  id="behave-tools"
                  checked={state.enableTools}
                  onCheckedChange={(v) => setField("enableTools", Boolean(v), true)}
                />
              </SettingsRow>
              <Separator />
              <SettingsRow label="自动记忆" htmlFor="behave-auto-mem">
                <Switch
                  id="behave-auto-mem"
                  checked={state.autoMemory}
                  disabled={!state.enableMemory}
                  onCheckedChange={(v) => setField("autoMemory", Boolean(v), true)}
                />
              </SettingsRow>
              <Separator />
              <SettingsRow label="自动标题" htmlFor="behave-auto-title">
                <Switch
                  id="behave-auto-title"
                  checked={state.autoTitle}
                  onCheckedChange={(v) => setField("autoTitle", Boolean(v), true)}
                />
              </SettingsRow>
              <Separator />
              <div className="flex items-center justify-between gap-4 py-1">
                <label htmlFor="max-rounds" className="text-sm font-medium">
                  最大工具轮次
                </label>
                <Input
                  id="max-rounds"
                  type="number"
                  min={1}
                  placeholder="不限"
                  className="w-28"
                  value={state.maxToolRounds}
                  onChange={(e) => setField("maxToolRounds", e.target.value)}
                />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="settings-subagent" title="子代理">
            <div className="flex items-center justify-between gap-4">
              <label className="text-sm font-medium">嵌套深度</label>
              <Select
                value={state.maxSubagentDepth}
                onValueChange={(v) => {
                  if (v != null) setField("maxSubagentDepth", v, true);
                }}
                items={DEPTH_ITEMS}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPTH_ITEMS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsSection>

          <SettingsSection
            id="settings-danger"
            title="危险区"
            description="不可逆操作，请谨慎。"
            className="border-destructive/30"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium">删除此 Agent</div>
                <p className="text-xs text-muted-foreground">
                  将移除配置与绑定；可选择是否同时清除工作区数据。
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={() => void removeAgent()}
              >
                <Trash2 className="size-4" />
                {deleting ? "删除中…" : "删除 Agent"}
              </Button>
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
