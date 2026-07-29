"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  enabled: boolean;
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

  const visibleModels = useMemo(
    () =>
      variant === "onboarding"
        ? models.filter((model) => model.capability === "chat" && model.enabled)
        : models,
    [models, variant],
  );

  const applyModels = useCallback((nextModels: UpstreamModelItem[]) => {
    setModels(nextModels);
    const preferred =
      nextModels.find((model) => model.capability === "chat" && model.isDefault) ??
      nextModels.find((model) => model.capability === "chat" && model.enabled);
    if (preferred) setSelectedId((current) => current ?? preferred.id);
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

  const sync = useCallback(async () => {
    // 解析优先于此前可能仍在进行的首次空列表请求。
    ++modelRequestId.current;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api<SyncResult>(
        `/api/model-upstreams/${upstreamId}/sync-models`,
        { method: "POST", json: {} },
      );
      const unmatchedText = formatUnmatchedModels(result.unmatchedModels);
      setSyncMessage(
        result.synced > 0
          ? [`已解析 ${result.synced} 个模型`, result.message, unmatchedText]
              .filter(Boolean)
              .join("；")
          : result.message ?? "未能从上游读取模型列表",
      );
      const syncedModels = result.models ?? [];
      if (syncedModels.length > 0) applyModels(syncedModels);
      const next = await load(syncedModels);
      if (result.synced > 0 && variant === "manage") {
        toast.success(`已同步 ${result.synced} 个模型`);
      }
      if (unmatchedText) toast.message(unmatchedText);
      if (!next.some((model) => model.capability === "chat")) setManualOpen(true);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error));
      setManualOpen(true);
    } finally {
      setSyncing(false);
    }
  }, [applyModels, load, upstreamId, variant]);

  useEffect(() => {
    setSelectedId(null);
    setSyncMessage(null);
    setManualOpen(false);
    const requestKey = `${upstreamId}:${syncKey}`;
    if (autoSync && lastAutoSyncKey.current !== requestKey) {
      lastAutoSyncKey.current = requestKey;
      void sync();
      return;
    }
    void load();
  }, [autoSync, load, sync, syncKey, upstreamId]);

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
    if (!confirm("确认移除该模型？")) return;
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
            onClick={() => void sync()}
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
