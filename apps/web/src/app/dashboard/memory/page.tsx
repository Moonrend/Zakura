"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, HeartPulse, Star } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

type KindMeta = {
  kind: string;
  name: string;
  description: string;
  storesLocally: boolean;
};

type Provider = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  status: string;
  meta?: KindMeta;
};

type AgentUsage = {
  id: string;
  name: string;
  slug: string;
  enableMemory: boolean;
  memoryProviderId: string | null;
};

type Payload = {
  providers: Provider[];
  agents: AgentUsage[];
  note?: string;
};

const KIND_ITEMS = [
  { value: "builtin", label: "Built-in（关键词+可选向量）" },
  { value: "traditional", label: "传统记忆（全文注入）" },
  { value: "mem0", label: "mem0（远程语义检索）" },
  { value: "openviking", label: "OpenViking" },
];

export default function GlobalMemoryPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [kinds, setKinds] = useState<KindMeta[]>([]);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("builtin");
  const [isDefault, setIsDefault] = useState(false);
  const [defaultUserId, setDefaultUserId] = useState("default");
  const [maxChars, setMaxChars] = useState("32000");
  const [embEnabled, setEmbEnabled] = useState(false);
  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embApiKey, setEmbApiKey] = useState("");
  const [embModel, setEmbModel] = useState("text-embedding-3-small");
  const [embDimensions, setEmbDimensions] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<Payload & { kinds?: KindMeta[] }>("/api/memory-providers");
      setData(res);
      if (res.kinds) setKinds(res.kinds);
      else {
        const meta = await api<{ kinds: KindMeta[] }>("/api/memory-providers/meta");
        setKinds(meta.kinds);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kindMeta = useMemo(() => {
    const m = new Map(kinds.map((k) => [k.kind, k]));
    return m;
  }, [kinds]);

  function resetForm(p?: Provider | null) {
    setEdit(p ?? null);
    setName(p?.name ?? "");
    setKind(p?.kind ?? "builtin");
    setIsDefault(p?.isDefault ?? false);
    setDefaultUserId(String(p?.config.defaultUserId ?? "default"));
    setMaxChars(String(p?.config.maxChars ?? 32000));
    const emb =
      p?.config.embedding && typeof p.config.embedding === "object"
        ? (p.config.embedding as Record<string, unknown>)
        : {};
    setEmbEnabled(emb.enabled === true);
    setEmbBaseUrl(String(emb.baseUrl ?? ""));
    setEmbApiKey(String(emb.apiKey ?? ""));
    setEmbModel(String(emb.model ?? "text-embedding-3-small"));
    setEmbDimensions(emb.dimensions != null ? String(emb.dimensions) : "");
    setBaseUrl(String(p?.config.baseUrl ?? ""));
    setApiKey(String(p?.config.apiKey ?? ""));
    setHeaderName(String(p?.config.headerName ?? "Authorization"));
  }

  function openCreate() {
    resetForm(null);
    setOpen(true);
  }

  function openEdit(p: Provider) {
    resetForm(p);
    setOpen(true);
  }

  function buildConfig(): Record<string, unknown> {
    if (kind === "builtin") {
      return {
        defaultUserId,
        embedding: {
          enabled: embEnabled,
          baseUrl: embBaseUrl,
          apiKey: embApiKey,
          model: embModel,
          ...(embDimensions.trim()
            ? { dimensions: Number(embDimensions) || undefined }
            : {}),
        },
      };
    }
    if (kind === "traditional") return { maxChars: Number(maxChars) || 32000 };
    if (kind === "mem0") {
      return {
        baseUrl,
        apiKey,
        defaultUserId,
      };
    }
    return { baseUrl, apiKey, headerName };
  }

  async function save() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    if ((kind === "mem0" || kind === "openviking") && !baseUrl.trim() && !edit) {
      toast.error(kind === "mem0" ? "mem0 需要 Base URL" : "OpenViking 需要 Base URL");
      return;
    }
    if (kind === "mem0" && !baseUrl.trim() && edit) {
      toast.error("mem0 需要 Base URL");
      return;
    }
    setBusy(true);
    try {
      if (edit) {
        await api(`/api/memory-providers/${edit.id}`, {
          method: "PATCH",
          json: { name: name.trim(), config: buildConfig(), isDefault },
        });
        toast.success("已更新");
      } else {
        await api("/api/memory-providers", {
          method: "POST",
          json: {
            name: name.trim(),
            kind,
            config: buildConfig(),
            isDefault,
          },
        });
        toast.success("已创建");
      }
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("删除此记忆 Provider？绑定到它的 Agent 需先更换。")) return;
    try {
      await api(`/api/memory-providers/${id}`, { method: "DELETE" });
      toast.success("已删除");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function health(id: string) {
    try {
      const res = await api<{ status: string; message?: string }>(
        `/api/memory-providers/${id}/health`,
        { method: "POST" },
      );
      toast.message(`健康检查：${res.status}`, { description: res.message });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function makeDefault(id: string) {
    try {
      await api(`/api/memory-providers/${id}`, {
        method: "PATCH",
        json: { isDefault: true },
      });
      toast.success("已设为默认");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (!data) return <div className="text-sm text-muted-foreground">…</div>;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="记忆"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus />
            新建
          </Button>
        }
      />

      <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>默认</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>引用 Agent</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.providers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    暂无 Provider
                  </TableCell>
                </TableRow>
              ) : (
                data.providers.map((p) => {
                  const refs = data.agents.filter(
                    (a) => a.memoryProviderId === p.id || (!a.memoryProviderId && p.isDefault),
                  );
                  const meta = kindMeta.get(p.kind);
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium underline-offset-2 hover:underline"
                          onClick={() => openEdit(p)}
                        >
                          {p.name}
                        </button>
                        <div className="text-[11px] text-muted-foreground">{p.slug}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{meta?.name ?? p.kind}</Badge>
                      </TableCell>
                      <TableCell>{p.isDefault ? <Badge>默认</Badge> : "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.status}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {refs.length === 0
                          ? "—"
                          : refs.map((a) => a.name).join("、")}
                      </TableCell>
                      <TableCell>
                        <TableActions>
                          {!p.isDefault && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="设为默认"
                              onClick={() => void makeDefault(p.id)}
                            >
                              <Star className="size-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            title="健康检查"
                            onClick={() => void health(p.id)}
                          >
                            <HeartPulse className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="删除"
                            onClick={() => void remove(p.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </TableActions>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{edit ? "编辑 Provider" : "新建记忆 Provider"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>名称</Label>
              <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {!edit && (
              <div>
                <Label>类型</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    if (v != null) setKind(v);
                  }}
                  items={KIND_ITEMS}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_ITEMS.map((i) => (
                      <SelectItem key={i.value} value={i.value}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {(kind === "builtin" || kind === "mem0") && (
              <div>
                <Label>默认 user_id</Label>
                <Input
                  className="mt-1"
                  value={defaultUserId}
                  onChange={(e) => setDefaultUserId(e.target.value)}
                />
              </div>
            )}
            {kind === "builtin" && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>启用向量语义种子</Label>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Hybrid 检索：embedding 写入 pgvector（PGlite / Postgres 均支持），与关键词融合后再扩图谱。
                    </p>
                  </div>
                  <Switch checked={embEnabled} onCheckedChange={setEmbEnabled} />
                </div>
                {embEnabled && (
                  <>
                    <div>
                      <Label>Embedding Base URL</Label>
                      <Input
                        className="mt-1"
                        value={embBaseUrl}
                        onChange={(e) => setEmbBaseUrl(e.target.value)}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div>
                      <Label>API Key</Label>
                      <Input
                        className="mt-1"
                        type="password"
                        value={embApiKey}
                        onChange={(e) => setEmbApiKey(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label>模型</Label>
                        <Input
                          className="mt-1"
                          value={embModel}
                          onChange={(e) => setEmbModel(e.target.value)}
                          placeholder="text-embedding-3-small"
                        />
                      </div>
                      <div>
                        <Label>维度（可选）</Label>
                        <Input
                          className="mt-1"
                          value={embDimensions}
                          onChange={(e) => setEmbDimensions(e.target.value)}
                          placeholder="1536"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {kind === "traditional" && (
              <div>
                <Label>全文注入最大字符数</Label>
                <Input
                  className="mt-1"
                  value={maxChars}
                  onChange={(e) => setMaxChars(e.target.value)}
                />
              </div>
            )}
            {kind === "mem0" && (
              <>
                <p className="text-[11px] text-muted-foreground">
                  mem0 必须指向已部署实例（Platform 或自托管 OSS）。语义检索依赖 mem0
                  侧的 embedding + 向量库；Zakura 只做 HTTP 代理，不提供「无向量的本地
                  mem0」。无向量需求请选 Built-in 或传统记忆。
                </p>
                <div>
                  <Label>Base URL</Label>
                  <Input
                    className="mt-1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.mem0.ai 或 http://127.0.0.1:8000"
                  />
                </div>
                <div>
                  <Label>API Key</Label>
                  <Input
                    className="mt-1"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              </>
            )}
            {kind === "openviking" && (
              <>
                <div>
                  <Label>Base URL</Label>
                  <Input
                    className="mt-1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:1933"
                  />
                </div>
                <div>
                  <Label>API Key</Label>
                  <Input
                    className="mt-1"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
                <div>
                  <Label>鉴权 Header</Label>
                  <Input
                    className="mt-1"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <Label>设为租户默认</Label>
              <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
