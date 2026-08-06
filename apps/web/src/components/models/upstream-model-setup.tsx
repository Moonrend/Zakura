"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
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
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type UpstreamModelItem = {
  id: string;
  nativeModel: string;
  canonicalModel: string;
  displayName?: string | null;
  capability: string;
  isDefault?: boolean;
};

type Props = {
  upstreamId: string;
  /** 首次挂载后立即尝试从上游解析模型。 */
  autoSync?: boolean;
  /** 连接信息保存后递增此值，以重新解析模型。 */
  syncKey?: number;
  /** onboarding 只需选择对话模型；manage 可管理全部能力。 */
  variant?: "onboarding" | "manage";
  onReady?: (model: UpstreamModelItem) => void;
};

const CAPABILITY_ITEMS = [
  { value: "chat", label: "对话" },
  { value: "embedding", label: "向量化" },
  { value: "rerank", label: "重排序" },
  { value: "image", label: "生图" },
];

const CAPABILITY_LABEL = Object.fromEntries(
  CAPABILITY_ITEMS.map((item) => [item.value, item.label]),
);

type SyncResult = {
  synced: number;
  created: number;
  updated: number;
  message?: string;
  models?: UpstreamModelItem[];
  unmatchedModels?: Array<{
    nativeModel: string;
    displayName?: string;
    canonicalModel: string;
  }>;
};

type RemoteModel = {
  id: string;
  name?: string;
  ownedBy?: string;
  capability?: string;
};

type ModelGroup = {
  key: string;
  label: string;
  models: RemoteModel[];
};

function formatUnmatchedModels(models?: SyncResult["unmatchedModels"]): string | null {
  if (!models?.length) return null;
  return `以下模型匹配失败，需要手动选数据：${models
    .map((model) => model.nativeModel)
    .join("、")}`;
}

export function UpstreamModelSetup({
  upstreamId,
  autoSync = false,
  syncKey = 0,
  variant = "manage",
  onReady,
}: Props) {
  const lastAutoSyncKey = useRef<string | null>(null);
  const modelRequestId = useRef(0);
  const modelsRef = useRef<UpstreamModelItem[]>([]);
  const [models, setModels] = useState<UpstreamModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [nativeModel, setNativeModel] = useState("");
  const [canonicalModel, setCanonicalModel] = useState("");
  const [capability, setCapability] = useState("chat");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const visibleModels = useMemo(
    () => models.filter((model) => variant === "manage" || model.capability === "chat"),
    [models, variant],
  );

  const filteredRemoteModels = useMemo(() => {
    const query = pickerSearch.trim().toLowerCase();
    if (!query) return remoteModels;
    return remoteModels.filter((model) =>
      [model.id, model.name, model.ownedBy].filter(Boolean).some((value) =>
        String(value).toLowerCase().includes(query),
      ),
    );
  }, [pickerSearch, remoteModels]);

  const modelGroups = useMemo<ModelGroup[]>(() => {
    const groups = new Map<string, RemoteModel[]>();
    for (const model of filteredRemoteModels) {
      const key = model.ownedBy?.trim() || model.id.split("/")[0] || "其他模型";
      groups.set(key, [...(groups.get(key) ?? []), model]);
    }
    return [...groups.entries()]
      .map(([key, groupModels]) => ({ key, label: key, models: groupModels }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredRemoteModels]);

  // 组选择的作用域永远是当前搜索结果，而不是远程模型全集。
  const visibleRemoteIds = useMemo(
    () => new Set(filteredRemoteModels.map((model) => model.id)),
    [filteredRemoteModels],
  );
  const selectedVisibleCount = filteredRemoteModels.filter((model) =>
    selectedRemoteIds.has(model.id),
  ).length;
  const selectedRemoteCount = selectedRemoteIds.size;

  function setSelectedInScope(scope: RemoteModel[], checked: boolean) {
    setSelectedRemoteIds((current) => {
      const next = new Set(current);
      for (const model of scope) {
        // 防止未来调用方传入过滤范围之外的模型。
        if (!visibleRemoteIds.has(model.id)) continue;
        if (checked) next.add(model.id);
        else next.delete(model.id);
      }
      return next;
    });
  }

  const applyModels = useCallback((nextModels: UpstreamModelItem[]) => {
    modelsRef.current = nextModels;
    setModels(nextModels);
    const preferred =
      nextModels.find((model) => model.capability === "chat" && model.isDefault) ??
      nextModels.find((model) => model.capability === "chat");
    if (preferred) setSelectedId((current) => current ?? preferred.id);
    else setSelectedId(null);
  }, []);

  const load = useCallback(async (fallbackModels: UpstreamModelItem[] = []) => {
    const requestId = ++modelRequestId.current;
    setLoading(true);
    try {
      const res = await api<{ models: UpstreamModelItem[] }>(
        `/api/upstream-models?upstreamId=${encodeURIComponent(upstreamId)}`,
      );
      const nextModels = res.models.length > 0 ? res.models : fallbackModels;
      if (requestId === modelRequestId.current) applyModels(nextModels);
      return nextModels;
    } catch (error) {
      if (requestId === modelRequestId.current) {
        toast.error(error instanceof Error ? error.message : String(error));
        if (fallbackModels.length > 0) applyModels(fallbackModels);
      }
      return fallbackModels;
    } finally {
      if (requestId === modelRequestId.current) setLoading(false);
    }
  }, [applyModels, upstreamId]);

  const fetchRemoteModels = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api<{ models: RemoteModel[]; message?: string }>(
        `/api/model-upstreams/${upstreamId}/models`,
      );
      setRemoteModels(result.models ?? []);
      const existingIds = new Set(
        modelsRef.current.map((model) => model.nativeModel),
      );
      setSelectedRemoteIds(new Set((result.models ?? []).filter((model) => existingIds.has(model.id)).map((model) => model.id)));
      setPickerSearch("");
      setCollapsedGroups(new Set());
      setPickerOpen(true);
      if (result.message) setSyncMessage(result.message);
      if ((result.models ?? []).length === 0) setManualOpen(true);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error));
      setManualOpen(true);
    } finally {
      setSyncing(false);
    }
  }, [upstreamId]);

  async function confirmRemoteModels() {
    setSaving(true);
    try {
      const result = await api<SyncResult>(`/api/model-upstreams/${upstreamId}/sync-models`, {
        method: "POST",
        json: { modelIds: [...selectedRemoteIds] },
      });
      const unmatchedText = formatUnmatchedModels(result.unmatchedModels);
      setSyncMessage(
        `已添加 ${selectedRemoteIds.size} 个模型` + (unmatchedText ? `；${unmatchedText}` : ""),
      );
      setPickerOpen(false);
      await load();
      if (unmatchedText) toast.message(unmatchedText);
      toast.success(`已添加 ${selectedRemoteIds.size} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    setSelectedId(null);
    setSyncMessage(null);
    setManualOpen(false);
    const requestKey = `${upstreamId}:${syncKey}`;
    if (autoSync && lastAutoSyncKey.current !== requestKey) {
      lastAutoSyncKey.current = requestKey;
      void fetchRemoteModels();
      return;
    }
    void load();
  }, [autoSync, fetchRemoteModels, load, syncKey, upstreamId]);

  async function addManualModel() {
    if (!nativeModel.trim()) {
      toast.error("请填写模型 ID");
      return;
    }
    setSaving(true);
    try {
      const created = await api<UpstreamModelItem>("/api/upstream-models", {
        method: "POST",
        json: {
          upstreamId,
          nativeModel: nativeModel.trim(),
          canonicalModel: canonicalModel.trim() || undefined,
          capability,
        },
      });
      setNativeModel("");
      setCanonicalModel("");
      setManualOpen(false);
      setSelectedId(created.capability === "chat" ? created.id : selectedId);
      await load();
      toast.success("模型已添加");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function chooseDefault() {
    const selected = models.find((model) => model.id === selectedId);
    if (!selected) {
      toast.error("请选择一个对话模型");
      return;
    }
    setSaving(true);
    try {
      const updated = await api<UpstreamModelItem>(`/api/upstream-models/${selected.id}`, {
        method: "PATCH",
        json: { isDefault: true },
      });
      setModels((current) =>
        current.map((model) => ({
          ...model,
          isDefault: model.id === updated.id,
        })),
      );
      onReady?.(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeModel(id: string) {
    try {
      await api(`/api/upstream-models/${id}`, { method: "DELETE" });
      if (selectedId === id) setSelectedId(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {variant === "onboarding" ? "选择对话模型" : "模型"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {variant === "onboarding"
              ? "已自动读取提供商中的可用模型。选择一个作为默认模型。"
              : "从上游自动解析模型；不支持模型列表的服务也可手动添加。"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={syncing || loading}
            onClick={() => void fetchRemoteModels()}
          >
            <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
            {syncing ? "正在解析" : "重新解析"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setManualOpen((open) => !open)}>
            <Plus className="size-3.5" />
            手动添加
          </Button>
        </div>
      </div>

      {syncing ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" />
          正在连接提供商并解析模型…
        </div>
      ) : syncMessage ? (
        <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {syncMessage}
        </p>
      ) : null}

      {manualOpen ? (
        <div className="grid gap-3 rounded-lg border border-border bg-muted/15 p-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`native-model-${upstreamId}`}>模型 ID</Label>
            <Input
              id={`native-model-${upstreamId}`}
              value={nativeModel}
              onChange={(event) => setNativeModel(event.target.value)}
              placeholder="例如 claude-sonnet-4-20250514"
            />
          </div>
          {variant === "manage" ? (
            <>
              <div className="space-y-1.5">
                <Label>规范名（可选）</Label>
                <Input
                  value={canonicalModel}
                  onChange={(event) => setCanonicalModel(event.target.value)}
                  placeholder="自动匹配"
                />
              </div>
              <div className="space-y-1.5">
                <Label>能力</Label>
                <Select value={capability} onValueChange={(value) => value && setCapability(value)} items={CAPABILITY_ITEMS}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAPABILITY_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" variant="ghost" onClick={() => setManualOpen(false)}>取消</Button>
            <Button size="sm" disabled={saving || !nativeModel.trim()} onClick={() => void addManualModel()}>
              {saving ? <Loader2 className="animate-spin" /> : <Plus />}
              添加模型
            </Button>
          </div>
        </div>
      ) : null}

      {loading && !syncing ? (
        <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载模型…
        </div>
      ) : visibleModels.length > 0 ? (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {visibleModels.map((model) => {
            const selected = selectedId === model.id;
            return (
              <div
                key={model.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  selected ? "border-foreground/35 bg-muted/35" : "border-border",
                )}
              >
                {variant === "onboarding" ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
                    onClick={() => setSelectedId(model.id)}
                  >
                    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", selected && "border-foreground bg-foreground text-background")}>
                      {selected ? <Check className="size-3" /> : null}
                    </span>
                    <ModelName model={model} />
                  </button>
                ) : (
                  <>
                    <ModelName model={model} />
                    {model.isDefault ? <Badge variant="secondary">默认</Badge> : null}
                    <Button size="icon" variant="ghost" title="删除模型" onClick={() => void removeModel(model.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : !syncing ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">没有解析到可用模型</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setManualOpen(true)}>
            手动添加模型
          </Button>
        </div>
      ) : null}

      {variant === "onboarding" && visibleModels.length > 0 ? (
        <Button className="w-full" disabled={!selectedId || saving} onClick={() => void chooseDefault()}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {saving ? "正在保存…" : "使用所选模型"}
        </Button>
      ) : null}

      <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <SheetHeader className="border-b border-border bg-muted/20 pr-12">
            <SheetTitle className="flex items-center gap-2">
              选择要添加的模型
              <Badge variant="secondary">{remoteModels.length.toLocaleString()} 个</Badge>
            </SheetTitle>
            <SheetDescription>
              按提供商分组展示。已添加的模型会自动选中，确认后才会加入模型列表。
            </SheetDescription>
          </SheetHeader>

          <div className="border-b border-border px-4 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={pickerSearch}
                onChange={(event) => setPickerSearch(event.target.value)}
                placeholder="搜索模型名或提供商…"
                className="pl-9 pr-9"
                autoFocus
              />
              {pickerSearch ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setPickerSearch("")}
                  aria-label="清除搜索"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>显示 {filteredRemoteModels.length.toLocaleString()} 个模型</span>
              <span className="font-medium text-foreground">
                当前显示已选 {selectedVisibleCount.toLocaleString()} 个
                {selectedVisibleCount !== selectedRemoteCount
                  ? ` · 共已选 ${selectedRemoteCount.toLocaleString()} 个`
                  : ""}
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {modelGroups.length > 0 ? (
              <div className="space-y-2">
                {modelGroups.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  const selectedCount = group.models.filter((model) => selectedRemoteIds.has(model.id)).length;
                  const allSelected = selectedCount === group.models.length;
                  return (
                    <section key={group.key} className="overflow-hidden rounded-lg border border-border/80 bg-card">
                      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                            return next;
                          })}
                          aria-expanded={!collapsed}
                        >
                          {collapsed ? <ChevronRight className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
                          <span className="truncate text-sm font-semibold">{group.label}</span>
                          <span className="text-xs text-muted-foreground">{group.models.length}</span>
                        </button>
                        <Checkbox
                          checked={allSelected}
                          data-partial={selectedCount > 0 && !allSelected ? "true" : undefined}
                          onCheckedChange={(checked) => setSelectedInScope(group.models, checked)}
                          aria-label={`选择当前显示的 ${group.label} 模型${selectedCount > 0 && !allSelected ? "（部分已选）" : ""}`}
                        />
                        <span className="sr-only">选择整组</span>
                      </div>
                      {!collapsed ? (
                        <div className="divide-y divide-border/60">
                          {group.models.map((model) => {
                            const checked = selectedRemoteIds.has(model.id);
                            return (
                              <label key={model.id} className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40", checked && "bg-muted/25")}>
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(value) => setSelectedRemoteIds((current) => {
                                    const next = new Set(current);
                                    if (value) next.add(model.id); else next.delete(model.id);
                                    return next;
                                  })}
                                  aria-label={`选择 ${model.name || model.id}`}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm">{model.name || model.id}</span>
                                  <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">{model.id}</code>
                                </span>
                                {checked ? <Check className="size-4 shrink-0 text-foreground" /> : null}
                              </label>
                            );
                          })}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-4 py-10 text-center">
                <p className="text-sm font-medium">没有匹配的模型</p>
                <p className="mt-1 text-xs text-muted-foreground">换个关键词试试，或使用手动添加。</p>
              </div>
            )}
          </div>

          <SheetFooter className="border-t border-border bg-background sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" onClick={() => setSelectedRemoteIds(new Set())} disabled={selectedRemoteCount === 0}>
              清空选择
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setPickerOpen(false)}>取消</Button>
              <Button disabled={saving} onClick={() => void confirmRemoteModels()}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                确定添加{selectedRemoteCount > 0 ? `（${selectedRemoteCount}）` : ""}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ModelName({ model }: { model: UpstreamModelItem }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">
        {model.displayName || model.nativeModel}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <code className="truncate text-[11px] text-muted-foreground">{model.nativeModel}</code>
        <Badge variant="outline">{CAPABILITY_LABEL[model.capability] ?? model.capability}</Badge>
      </span>
    </span>
  );
}
