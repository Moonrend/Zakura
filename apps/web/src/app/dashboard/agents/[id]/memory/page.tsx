"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Pin, Plus, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  SettingsHeader,
  SettingsRow,
  SettingsSection,
  TableActions,
} from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

const LAYERS = ["identity", "preference", "project", "fact", "episode", "note"] as const;

type MemItem = {
  id: string;
  content: string;
  layer: string;
  tags: string[];
  pinned: boolean;
  importance: number;
  userId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
};

type ProviderOpt = {
  id: string;
  name: string;
  kind: string;
  isDefault?: boolean;
  meta?: { name: string; description: string; storesLocally: boolean };
};

type Stats = {
  total: number;
  pinned: number;
  byLayer: Record<string, number>;
};

type MemoryMeta = {
  enabled: boolean;
  memoryProviderId: string | null;
  provider: {
    id: string;
    name: string;
    kind: string;
    storesLocally: boolean;
  } | null;
  providers: ProviderOpt[];
  stats: Stats;
  embedding?: {
    enabled: boolean;
    model: string | null;
    stats: { total: number; withEmbedding: number; missing: number; stale: number };
  } | null;
};

export default function AgentMemoryPage() {
  const { confirm } = useConfirmDialog();
  const { id, agent, refresh } = useAgentDetail();
  const [meta, setMeta] = useState<MemoryMeta | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [items, setItems] = useState<MemItem[]>([]);
  const [q, setQ] = useState("");
  const [layer, setLayer] = useState("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [mode, setMode] = useState<"list" | "search">("list");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<MemItem | null>(null);
  const [content, setContent] = useState("");
  const [formLayer, setFormLayer] = useState<string>("fact");
  const [formPinned, setFormPinned] = useState(false);
  const [formImportance, setFormImportance] = useState("3");
  const [formTags, setFormTags] = useState("");
  const [busy, setBusy] = useState(false);

  const kind = meta?.provider?.kind ?? "builtin";
  const storesLocally = meta?.provider?.storesLocally !== false;
  const isTraditional = kind === "traditional";

  const providerItems = useMemo(
    () =>
      (meta?.providers ?? []).map((p) => ({
        value: p.id,
        label: `${p.name}${p.isDefault ? "（默认）" : ""} · ${p.meta?.name ?? p.kind}`,
      })),
    [meta?.providers],
  );

  const loadMeta = useCallback(async () => {
    const m = await api<MemoryMeta>(`/api/agents/${id}/memory`);
    setMeta(m);
    setProviderId(m.memoryProviderId || m.provider?.id || "");
    return m;
  }, [id]);

  const loadItems = useCallback(async () => {
    if (mode === "search" && q.trim()) {
      const res = await api<{ results: MemItem[] }>(
        `/api/agents/${id}/memory/search?q=${encodeURIComponent(q.trim())}&limit=30`,
      );
      setItems(res.results);
      return;
    }
    const paramsQs = new URLSearchParams();
    if (q.trim()) paramsQs.set("q", q.trim());
    if (layer !== "all") paramsQs.set("layer", layer);
    if (pinnedOnly) paramsQs.set("pinned", "1");
    paramsQs.set("limit", "100");
    const res = await api<{ items: MemItem[] }>(
      `/api/agents/${id}/memory/items?${paramsQs}`,
    );
    setItems(res.items);
  }, [id, q, layer, pinnedOnly, mode]);

  const load = useCallback(async () => {
    try {
      await Promise.all([loadMeta(), loadItems()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [loadMeta, loadItems]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleMemory(on: boolean) {
    setBusy(true);
    try {
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        json: { enableMemory: on },
      });
      await Promise.all([loadMeta(), refresh({ list: false })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider(nextId: string) {
    setBusy(true);
    try {
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        json: { memoryProviderId: nextId || null },
      });
      toast.success("已绑定记忆 Provider");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setEdit(null);
    setContent("");
    setFormLayer(isTraditional ? "note" : "fact");
    setFormPinned(false);
    setFormImportance("3");
    setFormTags("");
    setOpen(true);
  }

  function openEdit(m: MemItem) {
    setEdit(m);
    setContent(m.content);
    setFormLayer(m.layer);
    setFormPinned(m.pinned);
    setFormImportance(String(m.importance ?? 3));
    setFormTags((m.tags ?? []).join(", "));
    setOpen(true);
  }

  async function saveItem() {
    if (!content.trim()) return;
    const tags = formTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const body = {
      content: content.trim(),
      layer: isTraditional ? "note" : formLayer,
      pinned: formPinned,
      importance: Number(formImportance) || 3,
      tags,
    };
    try {
      if (edit) {
        await api(`/api/agents/${id}/memory/items/${edit.id}`, {
          method: "PATCH",
          json: body,
        });
      } else {
        await api(`/api/agents/${id}/memory/items`, {
          method: "POST",
          json: body,
        });
      }
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeItem(memId: string) {
    try {
      await api(`/api/agents/${id}/memory/items/${memId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function togglePin(m: MemItem) {
    try {
      await api(`/api/agents/${id}/memory/items/${m.id}`, {
        method: "PATCH",
        json: { pinned: !m.pinned },
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearAll() {
    if (!(await confirm({ title: "清空本 Agent 全部记忆？", description: "此操作不可恢复。", confirmLabel: "清空记忆" }))) return;
    try {
      await api(`/api/agents/${id}/memory`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (!agent || !meta) return <div className="text-sm text-muted-foreground">…</div>;

  return (
    <div className="space-y-5">
      <SettingsHeader title="记忆" />

      <SettingsSection>
        <SettingsRow label="启用" htmlFor="mem-enable">
          <Switch
            id="mem-enable"
            checked={agent.enableMemory}
            disabled={busy}
            onCheckedChange={(v) => void toggleMemory(v)}
          />
        </SettingsRow>
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <Label>Provider</Label>
          <Select
            value={providerId}
            onValueChange={(v) => {
              if (v != null) {
                setProviderId(v);
                void saveProvider(v);
              }
            }}
            items={providerItems}
            disabled={!agent.enableMemory || busy || providerItems.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择 Provider" />
            </SelectTrigger>
            <SelectContent>
              {providerItems.map((i) => (
                <SelectItem key={i.value} value={i.value}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!meta.provider ? (
            <p className="text-[11px] text-muted-foreground">
              <Link href="/dashboard/memory" className="underline">
                创建 Provider
              </Link>
            </p>
          ) : null}
        </div>
      </SettingsSection>

      {kind === "builtin" && storesLocally && agent.enableMemory ? (
        <BuiltinEmbeddingPanel agentId={id} initial={meta.embedding ?? undefined} />
      ) : null}

      {!storesLocally ? (
        <SettingsSection>
          <p className="text-sm text-muted-foreground">
            数据由外部服务管理（{kind}）。
          </p>
        </SettingsSection>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="secondary">共 {meta.stats.total}</Badge>
              <Badge variant="outline">钉 {meta.stats.pinned}</Badge>
              {!isTraditional &&
                LAYERS.map((l) =>
                  meta.stats.byLayer[l] ? (
                    <Badge key={l} variant="outline">
                      {l} {meta.stats.byLayer[l]}
                    </Badge>
                  ) : null,
                )}
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => void clearAll()}>
                清空
              </Button>
              <Button size="sm" onClick={openCreate} disabled={!agent.enableMemory}>
                <Plus />
                添加
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-xs"
              placeholder={isTraditional ? "筛选笔记" : "搜索 / 筛选"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadItems();
              }}
            />
            {!isTraditional && (
              <Select
                value={layer}
                onValueChange={(v) => {
                  if (v != null) setLayer(v);
                }}
                items={[
                  { value: "all", label: "全部层级" },
                  ...LAYERS.map((l) => ({ value: l, label: l })),
                ]}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部层级</SelectItem>
                  {LAYERS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center gap-1.5 text-sm">
              <Switch checked={pinnedOnly} onCheckedChange={setPinnedOnly} />
              仅钉选
            </div>
            {!isTraditional && (
              <>
                <Button
                  size="sm"
                  variant={mode === "list" ? "default" : "outline"}
                  onClick={() => {
                    setMode("list");
                    void loadItems();
                  }}
                >
                  列表
                </Button>
                <Button
                  size="sm"
                  variant={mode === "search" ? "default" : "outline"}
                  onClick={() => {
                    setMode("search");
                    void loadItems();
                  }}
                >
                  <Search />
                  召回
                </Button>
              </>
            )}
          </div>

          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>内容</TableHead>
                  {!isTraditional && <TableHead>层级</TableHead>}
                  {!isTraditional && <TableHead>重要</TableHead>}
                  <TableHead>来源</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={isTraditional ? 3 : 5}
                      className="text-center text-xs text-muted-foreground"
                    >
                      —
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="max-w-md">
                        <button
                          type="button"
                          className="line-clamp-2 text-left text-sm hover:underline"
                          onClick={() => openEdit(m)}
                        >
                          {m.pinned ? (
                            <Pin className="mr-1 inline h-3 w-3 text-warning-foreground" />
                          ) : null}
                          {m.content}
                        </button>
                      </TableCell>
                      {!isTraditional && (
                        <TableCell>
                          <Badge variant="secondary">{m.layer}</Badge>
                        </TableCell>
                      )}
                      {!isTraditional && (
                        <TableCell className="tabular-nums text-xs">{m.importance}</TableCell>
                      )}
                      <TableCell className="text-xs text-muted-foreground">
                        {m.source === "auto" ? (
                          <Badge variant="success" className="px-1.5 py-0 text-[10px]">
                            自动
                          </Badge>
                        ) : (
                          m.source
                        )}
                        {m.score != null ? ` · ${m.score.toFixed(1)}` : ""}
                      </TableCell>
                      <TableCell>
                        <TableActions>
                          <Button size="sm" variant="ghost" onClick={() => void togglePin(m)}>
                            <Pin className={m.pinned ? "text-warning-foreground" : ""} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeItem(m.id)}
                          >
                            <Trash2 />
                          </Button>
                        </TableActions>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {edit ? "编辑" : "添加"}
              {isTraditional ? "笔记" : "记忆"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>内容</Label>
              <Textarea
                className="mt-1"
                rows={4}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
            {!isTraditional && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>层级</Label>
                  <Select
                    value={formLayer}
                    onValueChange={(v) => {
                      if (v != null) setFormLayer(v);
                    }}
                    items={LAYERS.map((l) => ({ value: l, label: l }))}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LAYERS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>重要性 1–5</Label>
                  <Input
                    className="mt-1"
                    value={formImportance}
                    onChange={(e) => setFormImportance(e.target.value)}
                  />
                </div>
              </div>
            )}
            {!isTraditional && (
              <div>
                <Label>标签（逗号分隔）</Label>
                <Input
                  className="mt-1"
                  value={formTags}
                  onChange={(e) => setFormTags(e.target.value)}
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <Label>钉选</Label>
              <Switch checked={formPinned} onCheckedChange={setFormPinned} />
            </div>
            <Button size="sm" className="w-full" onClick={() => void saveItem()}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BuiltinEmbeddingPanel({
  agentId,
  initial,
}: {
  agentId: string;
  initial?: {
    enabled: boolean;
    model: string | null;
    stats: { total: number; withEmbedding: number; missing: number; stale: number };
  };
}) {
  const [info, setInfo] = useState<{
    enabled: boolean;
    model: string | null;
    stats: { total: number; withEmbedding: number; missing: number; stale: number };
  } | null>(initial ?? null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{
        enabled: boolean;
        model: string | null;
        stats: { total: number; withEmbedding: number; missing: number; stale: number };
      }>(`/api/agents/${agentId}/memory/embedding-stats`);
      setInfo(res);
    } catch {
      setInfo(null);
    }
  }, [agentId]);

  useEffect(() => {
    if (initial) {
      setInfo(initial);
      return;
    }
    void load();
  }, [initial, load]);

  async function reembed() {
    setBusy(true);
    try {
      const res = await api<{
        updated: number;
        failed: number;
        errors: string[];
        stats: { total: number; withEmbedding: number; missing: number; stale: number };
      }>(`/api/agents/${agentId}/memory/reembed`, { method: "POST" });
      toast.success(`已重建 ${res.updated} 条向量${res.failed ? `，失败 ${res.failed}` : ""}`);
      if (res.errors?.length) toast.message(res.errors[0]!);
      setInfo((prev) =>
        prev
          ? { ...prev, stats: res.stats, enabled: true }
          : { enabled: true, model: null, stats: res.stats },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;

  return (
    <SettingsSection
      title="向量索引"
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={!info.enabled || busy}
          onClick={() => void reembed()}
        >
          重建
        </Button>
      }
    >
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Badge variant="secondary">总 {info.stats.total}</Badge>
        <Badge variant="outline">已嵌入 {info.stats.withEmbedding}</Badge>
        <Badge variant="outline">缺失 {info.stats.missing}</Badge>
        {info.stats.stale > 0 ? (
          <Badge variant="outline">过期 {info.stats.stale}</Badge>
        ) : null}
      </div>
    </SettingsSection>
  );
}
