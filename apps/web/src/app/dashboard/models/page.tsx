"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  listModelsByCapability,
  type ChatModelOption,
  type ModelCapabilityFilter,
} from "@/lib/cloud-agent";
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
type CapabilityMeta = { capability: string; name: string; description: string };

type Upstream = {
  id: string;
  name: string;
  slug: string;
  protocol: string;
  status: string;
};

type Deployment = {
  id: string;
  upstreamId: string;
  nativeModel: string;
  canonicalModel: string;
  displayName?: string | null;
  capability: string;
  weight: number;
  isDefault: boolean;
  status: string;
  options?: {
    reasoning?: {
      enabled?: boolean;
      effort?: string;
      budgetTokens?: number;
      summary?: string;
      includeThoughts?: boolean;
    };
  };
  meta?: Record<string, unknown>;
  upstream?: Upstream;
};

type LogicalModel = {
  canonicalModel: string;
  displayName: string;
  capability: string;
  isDefault: boolean;
  deployments: Deployment[];
};

type ModelMatchFailure = {
  nativeModel: string;
  displayName?: string;
  canonicalModel: string;
};

const CAPABILITY_LABEL: Record<string, string> = {
  chat: "对话",
  embedding: "向量化",
  rerank: "重排序",
  image: "生图",
};

const DEFAULT_CAPABILITIES: ModelCapabilityFilter[] = [
  "chat",
  "embedding",
  "rerank",
  "image",
];

function toSelectorItems(models: ChatModelOption[]): ModelRouteSelectorItem[] {
  return models.map((m) => ({
    value: m.alias,
    label: m.name,
    hint: m.upstream,
    keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
    providers: m.providers,
  }));
}

type FlatRow = Deployment & {
  groupDisplayName: string;
};

type ReasoningPreset = "default" | "off" | (string & {});

const REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

function reasoningLabel(value: string): string {
  const normalized = value.toLowerCase();
  return (
    REASONING_LABELS[normalized] ??
    value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function reasoningPresetsFromLevels(
  levels?: readonly string[],
): Array<{ value: ReasoningPreset; label: string }> {
  if (!levels) return [{ value: "default", label: "默认" }];
  const items: Array<{ value: ReasoningPreset; label: string }> = [
    { value: "default", label: "默认" },
  ];
  const seen = new Set<string>(["default"]);
  for (const raw of levels) {
    const value = String(raw).trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (normalized === "none") {
      if (!seen.has("off")) {
        items.push({ value: "off", label: "关闭" });
        seen.add("off");
      }
      continue;
    }
    if (seen.has(normalized)) continue;
    items.push({ value: value as ReasoningPreset, label: reasoningLabel(value) });
    seen.add(normalized);
  }
  return items;
}

function readReasoningLevelsFromMetaJson(raw: string): string[] | undefined {
  try {
    const meta = JSON.parse(raw) as { reasoningLevels?: unknown };
    return Array.isArray(meta.reasoningLevels)
      ? meta.reasoningLevels.map(String).filter(Boolean)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeReasoningPreset(value?: string): ReasoningPreset {
  if (value?.trim() && value !== "none") return value.trim() as ReasoningPreset;
  return "default";
}

function formatUnmatchedModels(models?: ModelMatchFailure[]): string | null {
  if (!models?.length) return null;
  return `以下模型仍匹配失败，需要手动选数据：${models
    .map((model) => model.nativeModel)
    .join("、")}`;
}

export default function ModelRoutesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
      <ModelRoutesPageInner />
    </Suspense>
  );
}

function ModelRoutesPageInner() {
  const { confirm } = useConfirmDialog();
  const searchParams = useSearchParams();
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [groups, setGroups] = useState<LogicalModel[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMeta[]>([]);
  const [capFilter, setCapFilter] = useState(
    () => searchParams.get("capability") ?? "all",
  );
  const [refreshingMeta, setRefreshingMeta] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [editDep, setEditDep] = useState<Deployment | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [upstreamId, setUpstreamId] = useState("");
  const [nativeModel, setNativeModel] = useState("");
  const [canonicalModel, setCanonicalModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [capability, setCapability] = useState("chat");
  const [weight, setWeight] = useState("100");
  const [reasoningPreset, setReasoningPreset] = useState<ReasoningPreset>("default");
  const [reasoningBudget, setReasoningBudget] = useState("");
  const [metaJson, setMetaJson] = useState("{}");
  const [defaultModels, setDefaultModels] = useState<
    Partial<Record<ModelCapabilityFilter, ChatModelOption[]>>
  >({});
  const [defaultsLoading, setDefaultsLoading] = useState(false);

  const capabilityItems = useMemo(
    () =>
      (capabilities.length
        ? capabilities
        : Object.entries(CAPABILITY_LABEL).map(([capability, name]) => ({
            capability,
            name,
            description: "",
          }))
      ).map((c) => ({ value: c.capability, label: c.name })),
    [capabilities],
  );

  const upstreamItems = useMemo(
    () => upstreams.map((u) => ({ value: u.id, label: u.name })),
    [upstreams],
  );

  const rows = useMemo<FlatRow[]>(
    () =>
      groups.flatMap((g) =>
        g.deployments.map((d) => ({
          ...d,
          groupDisplayName: g.displayName || g.canonicalModel,
        })),
      ),
    [groups],
  );

  const allSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.id));
  const formReasoningPresets = useMemo(
    () => reasoningPresetsFromLevels(readReasoningLevelsFromMetaJson(metaJson)),
    [metaJson],
  );

  useEffect(() => {
    if (!formReasoningPresets.some((item) => item.value === reasoningPreset)) {
      setReasoningPreset("default");
      setReasoningBudget("");
    }
  }, [formReasoningPresets, reasoningPreset]);

  const loadDefaults = useCallback(async () => {
    setDefaultsLoading(true);
    try {
      const entries = await Promise.all(
        DEFAULT_CAPABILITIES.map(async (capability) => {
          const models = await listModelsByCapability(capability);
          return [capability, models] as const;
        }),
      );
      setDefaultModels(Object.fromEntries(entries));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDefaultsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [upRes, modelRes] = await Promise.all([
        api<{ upstreams: Upstream[] }>("/api/model-upstreams"),
        api<{ models: LogicalModel[]; capabilities: CapabilityMeta[] }>(
          `/api/upstream-models?grouped=1${
            capFilter !== "all" ? `&capability=${capFilter}` : ""
          }`,
        ),
      ]);
      setUpstreams(upRes.upstreams);
      setGroups(modelRes.models);
      setSelected(new Set());
      if (modelRes.capabilities?.length) setCapabilities(modelRes.capabilities);
      void loadDefaults();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [capFilter, loadDefaults]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshMeta() {
    setRefreshingMeta(true);
    try {
      const res = await api<{
        imported: number;
        renamed?: number;
        rematched?: number;
        unmatchedModels?: ModelMatchFailure[];
        message?: string;
      }>("/api/model-catalog/refresh", { method: "POST", json: {} });
      toast.success(
        `元数据已刷新（导入 ${res.imported} 条${
          res.renamed != null ? `，重命名 ${res.renamed}` : ""
        }）`,
      );
      const unmatchedText = formatUnmatchedModels(res.unmatchedModels);
      if (unmatchedText) toast.message(unmatchedText);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingMeta(false);
    }
  }

  function openAdd() {
    setEditDep(null);
    setUpstreamId(upstreams[0]?.id ?? "");
    setNativeModel("");
    setCanonicalModel("");
    setDisplayName("");
    setCapability(capFilter !== "all" ? capFilter : "chat");
    setWeight("100");
    setReasoningPreset("default");
    setReasoningBudget("");
    setMetaJson("{}");
    setMetaOpen(false);
    setAddOpen(true);
  }

  function openEdit(d: Deployment) {
    setEditDep(d);
    setUpstreamId(d.upstreamId);
    setNativeModel(d.nativeModel);
    setCanonicalModel(d.canonicalModel);
    setDisplayName(d.displayName ?? "");
    setCapability(d.capability);
    setWeight(String(d.weight));
    setReasoningPreset(
      d.options?.reasoning
        ? d.options.reasoning.enabled === false
          ? "off"
          : normalizeReasoningPreset(d.options.reasoning.effort)
        : "default",
    );
    setReasoningBudget(
      d.options?.reasoning?.budgetTokens != null
        ? String(d.options.reasoning.budgetTokens)
        : "",
    );
    setMetaJson(JSON.stringify(d.meta ?? {}, null, 2));
    setMetaOpen(false);
    setAddOpen(true);
  }

  async function save() {
    if (!upstreamId || !nativeModel.trim()) {
      toast.error("请选择上游并填写原始模型名");
      return;
    }
    setBusy(true);
    try {
      let parsedMeta: Record<string, unknown> | undefined;
      try {
        parsedMeta = metaJson.trim() ? JSON.parse(metaJson) : {};
      } catch {
        toast.error("元数据 JSON 格式不正确");
        setBusy(false);
        return;
      }
      const options = {
        ...(reasoningPreset === "default"
          ? {}
          : reasoningPreset === "off"
            ? { reasoning: { enabled: false } }
            : {
                reasoning: {
                  enabled: true,
                  effort: reasoningPreset,
                  ...(reasoningBudget.trim()
                    ? { budgetTokens: Number(reasoningBudget) || undefined }
                    : {}),
                },
              }),
      };
      if (editDep) {
        await api(`/api/upstream-models/${editDep.id}`, {
          method: "PATCH",
          json: {
            nativeModel: nativeModel.trim(),
            canonicalModel: canonicalModel.trim() || undefined,
            displayName: displayName.trim() || null,
            capability,
            weight: Number(weight) || 100,
            options,
            meta: parsedMeta,
          },
        });
        toast.success("已更新");
      } else {
        await api("/api/upstream-models", {
          method: "POST",
          json: {
            upstreamId,
            nativeModel: nativeModel.trim(),
            canonicalModel: canonicalModel.trim() || undefined,
            displayName: displayName.trim() || undefined,
            capability,
            weight: Number(weight) || 100,
            options,
            meta: parsedMeta,
          },
        });
        toast.success("已添加");
      }
      setAddOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/upstream-models/${id}`, { method: "DELETE" });
      toast.success("已删除");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `删除选中的 ${ids.length} 条部署？`,
      description: "此操作不可恢复。",
      confirmLabel: "删除",
    }))) return;
    try {
      await api("/api/upstream-models/batch-delete", {
        method: "POST",
        json: { ids },
      });
      toast.success(`已删除 ${ids.length} 条`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function setCapabilityDefault(
    capability: ModelCapabilityFilter,
    alias: string | null,
    routeId: string | null,
  ) {
    if (!alias) return;
    const models = defaultModels[capability] ?? [];
    const item = models.find((m) => m.alias === alias);
    if (!item) {
      toast.error("未找到该模型");
      return;
    }
    const targetId =
      routeId ||
      item.providers[0]?.id ||
      null;
    if (!targetId) {
      toast.error("该模型没有可用部署");
      return;
    }
    try {
      await api(`/api/upstream-models/${targetId}`, {
        method: "PATCH",
        json: { isDefault: true },
      });
      toast.success(`已将 ${item.name} 设为${CAPABILITY_LABEL[capability] ?? capability}默认`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="模型"
        actions={
          <div className="flex flex-wrap gap-2">
            {selected.size > 0 ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void removeSelected()}
              >
                <Trash2 className="size-3.5" />
                删除选中（{selected.size}）
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={refreshingMeta}
              onClick={() => void refreshMeta()}
            >
              {refreshingMeta ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              刷新元数据
            </Button>
            <Button size="sm" onClick={openAdd} disabled={upstreams.length === 0}>
              <Plus />
              手填模型
            </Button>
          </div>
        }
      />

      <p className="text-sm text-muted-foreground">
        模型来自上游同步或手填。系统按规范名聚合；调用时使用各上游的原始名。同规范名多上游时加权随机。在
        <Link href="/dashboard/models/upstreams" className="mx-1 underline underline-offset-2">
          上游
        </Link>
        页点击「同步模型」拉取。
      </p>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium">团队默认模型</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            未指定模型时按能力使用下方选择；多上游可选「自动」动态路由。
          </p>
        </div>
        {defaultsLoading && Object.keys(defaultModels).length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载默认模型…
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {DEFAULT_CAPABILITIES.map((capability) => {
              const models = defaultModels[capability] ?? [];
              const selected = models.find((m) => m.isDefault) ?? null;
              return (
                <div key={capability} className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {CAPABILITY_LABEL[capability] ?? capability}
                  </Label>
                  <ModelRouteSelector
                    items={toSelectorItems(models)}
                    value={selected?.alias ?? null}
                    routeId={selected?.defaultRouteId ?? null}
                    onSelectionChange={(alias, routeId) =>
                      void setCapabilityDefault(capability, alias, routeId)
                    }
                    disabled={models.length === 0}
                    placeholder={models.length === 0 ? "暂无模型" : "选择默认模型"}
                    className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs text-muted-foreground">能力</Label>
        <Select
          value={capFilter}
          onValueChange={(v) => {
            if (v != null) setCapFilter(v);
          }}
          items={[
            { value: "all", label: "全部" },
            ...capabilityItems,
          ]}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {capabilityItems.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          暂无模型。请先配置上游，再在上游页点击「同步模型」，或在此手填。
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) => {
                    setSelected(() => {
                      if (v) return new Set(rows.map((r) => r.id));
                      return new Set();
                    });
                  }}
                  aria-label="全选"
                />
              </TableHead>
              <TableHead>模型</TableHead>
              <TableHead>能力</TableHead>
              <TableHead>上游</TableHead>
              <TableHead>原始名</TableHead>
              <TableHead className="w-16">权重</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(d.id)}
                    onCheckedChange={(v) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(d.id);
                        else next.delete(d.id);
                        return next;
                      });
                    }}
                    aria-label={`选择 ${d.nativeModel}`}
                  />
                </TableCell>
                <TableCell className="min-w-0 max-w-[14rem]">
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {d.groupDisplayName}
                    </span>
                  </div>
                  <code className="block truncate text-[10px] text-muted-foreground">
                    {d.canonicalModel}
                  </code>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {CAPABILITY_LABEL[d.capability] ?? d.capability}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[8rem] truncate text-sm">
                  {d.upstream?.name ?? d.upstreamId}
                </TableCell>
                <TableCell className="max-w-[10rem]">
                  <code className="block truncate text-xs">{d.nativeModel}</code>
                </TableCell>
                <TableCell className="text-sm tabular-nums">{d.weight}</TableCell>
                <TableCell>
                  <TableActions>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(d)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="删除"
                      onClick={() => void remove(d.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <SheetHeader className="border-b border-border pr-12">
            <SheetTitle>{editDep ? "编辑部署" : "手填模型"}</SheetTitle>
            <SheetDescription>
              {editDep ? "修改模型部署参数与默认调用选项。" : "选择上游并添加一个模型部署。"}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
            <div className="space-y-4">
              {!editDep ? (
                <div>
                  <Label>上游</Label>
                  <Select
                    value={upstreamId}
                    onValueChange={(v) => {
                      if (v != null) setUpstreamId(v);
                    }}
                    items={upstreamItems}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue placeholder="选择上游" />
                    </SelectTrigger>
                    <SelectContent>
                      {upstreamItems.map((u) => (
                        <SelectItem key={u.value} value={u.value}>
                          {u.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  上游：{editDep.upstream?.name ?? editDep.upstreamId}
                </p>
              )}
              <div>
                <Label>上游原始名（调用时使用）</Label>
                <Input
                  className="mt-1"
                  value={nativeModel}
                  onChange={(e) => setNativeModel(e.target.value)}
                  placeholder="DeepSeek-V4-Flash"
                />
              </div>
              <div>
                <Label>规范名（可选，留空则自动匹配/归一化）</Label>
                <Input
                  className="mt-1"
                  value={canonicalModel}
                  onChange={(e) => setCanonicalModel(e.target.value)}
                  placeholder="deepseek-v4-flash"
                />
              </div>
              <div>
                <Label>显示名</Label>
                <Input
                  className="mt-1"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="自动使用目录名称"
                />
              </div>
              <div>
                <Label>能力</Label>
                <Select
                  value={capability}
                  onValueChange={(v) => {
                    if (v != null) setCapability(v);
                  }}
                  items={capabilityItems}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {capabilityItems.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>权重</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
              </div>
              <div className="space-y-2 rounded-md border border-border p-3">
                <div>
                  <Label>默认思考强度</Label>
                  <Select
                    value={reasoningPreset}
                    onValueChange={(v) => {
                      if (!v) return;
                      setReasoningPreset(v as ReasoningPreset);
                      if (v === "default" || v === "off") setReasoningBudget("");
                    }}
                    items={formReasoningPresets}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {formReasoningPresets.map((preset) => (
                        <SelectItem key={preset.value} value={preset.value}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {reasoningPreset !== "default" && reasoningPreset !== "off" ? (
                  <div>
                    <Label>Token 预算</Label>
                    <Input
                      className="mt-1"
                      type="number"
                      min={1}
                      value={reasoningBudget}
                      onChange={(e) => setReasoningBudget(e.target.value)}
                      placeholder="自动"
                    />
                  </div>
                ) : null}
              </div>

              <div className="rounded-md border border-border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted/50"
                  onClick={() => setMetaOpen((v) => !v)}
                >
                  <span>模型元数据 JSON</span>
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${metaOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {metaOpen ? (
                  <div className="border-t border-border p-3">
                    <Textarea
                      className="min-h-56 max-h-[45vh] font-mono text-xs"
                      value={metaJson}
                      onChange={(e) => setMetaJson(e.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-border bg-popover p-4">
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                取消
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
