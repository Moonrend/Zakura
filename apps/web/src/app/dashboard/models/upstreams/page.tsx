"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HeartPulse, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UpstreamModelSetup } from "@/components/models/upstream-model-setup";
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
import {
  BAILIAN_ENDPOINTS,
  MODEL_UPSTREAM_DEFAULT_BASE_URLS,
  MODEL_UPSTREAM_PROTOCOL_META,
  MODEL_UPSTREAM_PROTOCOLS,
  type ModelUpstreamProtocol,
} from "@zakura/shared";

type FormField =
  | "apiKey"
  | "baseUrl"
  | "apiVersion"
  | "anthropicVersion"
  | "deploymentId"
  | "rerankBaseUrl"
  | "region";

type ProtocolMeta = {
  protocol: string;
  name: string;
  description: string;
  fields: FormField[];
  keywords?: string[];
};

type Upstream = {
  id: string;
  name: string;
  slug: string;
  protocol: string;
  config: Record<string, unknown>;
  resolvedConfig?: { baseUrl?: string };
  status: string;
  meta?: ProtocolMeta;
};

type ModelMatchFailure = {
  nativeModel: string;
  displayName?: string;
  canonicalModel: string;
};

const FALLBACK_PROTOCOLS: ProtocolMeta[] = MODEL_UPSTREAM_PROTOCOLS.map((protocol) => ({
  protocol,
  ...MODEL_UPSTREAM_PROTOCOL_META[protocol],
  fields: [...MODEL_UPSTREAM_PROTOCOL_META[protocol].fields],
  keywords: MODEL_UPSTREAM_PROTOCOL_META[protocol].keywords
    ? [...MODEL_UPSTREAM_PROTOCOL_META[protocol].keywords]
    : undefined,
}));

const REGION_ITEMS: { value: string; label: string }[] = [
  { value: "cn", label: "国内" },
  { value: "intl", label: "国际" },
];

function fieldsFor(protocol: string, protocols: ProtocolMeta[]): FormField[] {
  return (
    protocols.find((p) => p.protocol === protocol)?.fields ?? ["baseUrl", "apiKey"]
  );
}

function defaultBaseUrlFor(protocol: string, region = "cn"): string {
  if (protocol === "bailian") {
    return BAILIAN_ENDPOINTS[region === "intl" ? "intl" : "cn"].baseUrl;
  }
  return MODEL_UPSTREAM_DEFAULT_BASE_URLS[protocol as ModelUpstreamProtocol] ?? "";
}

function toggleId(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

function formatUnmatchedModels(models?: ModelMatchFailure[]): string | null {
  if (!models?.length) return null;
  const names = models.map((m) => m.nativeModel).join("、");
  return `以下模型匹配失败，需要手动选数据：${names}`;
}

export default function ModelUpstreamsPage() {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [protocols, setProtocols] = useState<ProtocolMeta[]>(FALLBACK_PROTOCOLS);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Upstream | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [selectedUpstreams, setSelectedUpstreams] = useState<Set<string>>(new Set());

  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiVersion, setApiVersion] = useState("2024-08-01-preview");
  const [anthropicVersion, setAnthropicVersion] = useState("2023-06-01");
  const [deploymentId, setDeploymentId] = useState("");
  const [rerankBaseUrl, setRerankBaseUrl] = useState("");
  const [region, setRegion] = useState("cn");

  const protocolItems = useMemo(
    () =>
      protocols.map((p) => ({
        value: p.protocol,
        label: p.name,
        keywords: p.keywords,
      })),
    [protocols],
  );

  const visibleFields = useMemo(
    () => new Set(fieldsFor(protocol, protocols)),
    [protocol, protocols],
  );

  const allUpstreamSelected =
    upstreams.length > 0 && upstreams.every((u) => selectedUpstreams.has(u.id));

  const load = useCallback(async () => {
    try {
      const res = await api<{ upstreams: Upstream[]; protocols: ProtocolMeta[] }>(
        "/api/model-upstreams",
      );
      setUpstreams(res.upstreams);
      setSelectedUpstreams(new Set());
      if (res.protocols?.length) {
        setProtocols(
          res.protocols.map((p) => {
            const fields = new Set<FormField>(
              (p.fields?.length ? p.fields : ["baseUrl", "apiKey"]) as FormField[],
            );
            fields.add("baseUrl");
            return {
              ...p,
              fields: [...fields],
              keywords: p.keywords,
            };
          }),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resetForm(u?: Upstream | null) {
    setEdit(u ?? null);
    setName(u?.name ?? "");
    const nextProtocol = u?.protocol ?? "openai";
    const nextRegion = String(u?.config.region ?? "cn");
    setProtocol(nextProtocol);
    setBaseUrl(
      String(u?.config.baseUrl ?? u?.resolvedConfig?.baseUrl ?? "") ||
        defaultBaseUrlFor(nextProtocol, nextRegion),
    );
    setApiKey("");
    setApiVersion(String(u?.config.apiVersion ?? "2024-08-01-preview"));
    setAnthropicVersion(String(u?.config.anthropicVersion ?? "2023-06-01"));
    setDeploymentId(String(u?.config.deploymentId ?? ""));
    setRerankBaseUrl(String(u?.config.rerankBaseUrl ?? ""));
    setRegion(nextRegion);
  }

  function openEdit(u: Upstream) {
    resetForm(u);
    setOpen(true);
  }

  function openCreate() {
    resetForm(null);
    setOpen(true);
  }

  function buildConfig(): Record<string, unknown> {
    const fields = fieldsFor(protocol, protocols);
    const config: Record<string, unknown> = {};
    if (fields.includes("apiKey") && apiKey.trim()) config.apiKey = apiKey.trim();
    config.baseUrl = baseUrl.trim();
    if (fields.includes("apiVersion")) config.apiVersion = apiVersion.trim();
    if (fields.includes("anthropicVersion")) {
      config.anthropicVersion = anthropicVersion.trim() || "2023-06-01";
    }
    if (fields.includes("deploymentId") && deploymentId.trim()) {
      config.deploymentId = deploymentId.trim();
    }
    if (fields.includes("rerankBaseUrl") && rerankBaseUrl.trim()) {
      config.rerankBaseUrl = rerankBaseUrl.trim();
    }
    if (fields.includes("region")) config.region = region;
    return config;
  }

  async function save() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    const fields = fieldsFor(protocol, protocols);
    if (!edit && fields.includes("apiKey") && !apiKey.trim() && protocol !== "custom") {
      toast.error("请填写 API Key");
      return;
    }
    if (!baseUrl.trim()) {
      toast.error("请填写 API 地址");
      return;
    }
    setBusy(true);
    try {
      const config = buildConfig();
      if (edit) {
        await api(`/api/model-upstreams/${edit.id}`, {
          method: "PATCH",
          json: { name: name.trim(), config },
        });
        toast.success("上游已更新");
        await load();
        const refreshed = await api<Upstream>(`/api/model-upstreams/${edit.id}`);
        resetForm(refreshed);
      } else {
        const created = await api<Upstream>("/api/model-upstreams", {
          method: "POST",
          json: { name: name.trim(), protocol, config },
        });
        toast.success("上游已创建，可继续添加模型");
        resetForm(created);
        await load();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedUpstreams() {
    const ids = [...selectedUpstreams];
    if (ids.length === 0) return;
    if (!confirm(`确认删除选中的 ${ids.length} 个上游？其下模型也会删除。`)) return;
    try {
      await api("/api/model-upstreams/batch-delete", {
        method: "POST",
        json: { ids },
      });
      toast.success(`已删除 ${ids.length} 个上游`);
      if (edit && ids.includes(edit.id)) setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeOneUpstream(id: string) {
    if (!confirm("删除上游将级联删除其下所有模型，确认？")) return;
    try {
      await api(`/api/model-upstreams/${id}`, { method: "DELETE" });
      toast.success("已删除");
      if (edit?.id === id) setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function syncModels(id: string) {
    setSyncingId(id);
    try {
      const res = await api<{
        synced: number;
        created: number;
        updated: number;
        message?: string;
        unmatchedModels?: ModelMatchFailure[];
      }>(`/api/model-upstreams/${id}/sync-models`, {
        method: "POST",
        json: {},
      });
      const unmatchedText = formatUnmatchedModels(res.unmatchedModels);
      if (res.synced === 0) {
        toast.message(res.message ?? "未同步到模型，可手填");
      } else {
        toast.success(
          `已同步 ${res.synced} 条（新增 ${res.created}，更新 ${res.updated}）` +
            (res.message ? ` · ${res.message}` : ""),
        );
      }
      if (unmatchedText) toast.message(unmatchedText);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingId(null);
    }
  }

  async function health(id: string) {
    try {
      const res = await api<{ status: string; message?: string }>(
        `/api/model-upstreams/${id}/health`,
        { method: "POST" },
      );
      toast[res.status === "healthy" ? "success" : "error"](
        res.message ?? res.status,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="上游连接"
        actions={
          <div className="flex flex-wrap gap-2">
            {selectedUpstreams.size > 0 ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void removeSelectedUpstreams()}
              >
                <Trash2 className="size-3.5" />
                删除选中（{selectedUpstreams.size}）
              </Button>
            ) : null}
            <Button size="sm" onClick={openCreate}>
              <Plus />
              新建上游
            </Button>
          </div>
        }
      />
      <p className="text-sm text-muted-foreground">
        按类型选择供应商。编辑在右侧侧栏中完成，支持批量选择与删除。
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allUpstreamSelected}
                onCheckedChange={(v) => {
                  if (v) setSelectedUpstreams(new Set(upstreams.map((u) => u.id)));
                  else setSelectedUpstreams(new Set());
                }}
                aria-label="全选上游"
              />
            </TableHead>
            <TableHead>名称</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>端点</TableHead>
            <TableHead>状态</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {upstreams.map((u) => (
            <TableRow key={u.id} data-state={selectedUpstreams.has(u.id) ? "selected" : undefined}>
              <TableCell>
                <Checkbox
                  checked={selectedUpstreams.has(u.id)}
                  onCheckedChange={(v) =>
                    setSelectedUpstreams((prev) => toggleId(prev, u.id, Boolean(v)))
                  }
                  aria-label={`选择 ${u.name}`}
                />
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  className="text-left font-medium underline-offset-2 hover:underline"
                  onClick={() => openEdit(u)}
                >
                  {u.name}
                </button>
                <div className="text-[11px] text-muted-foreground">{u.slug}</div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{u.meta?.name ?? u.protocol}</Badge>
              </TableCell>
              <TableCell className="max-w-xs truncate text-sm">
                {String(u.resolvedConfig?.baseUrl ?? u.config.baseUrl ?? "—")}
              </TableCell>
              <TableCell>
                <Badge variant={u.status === "ready" ? "secondary" : "destructive"}>
                  {u.status}
                </Badge>
              </TableCell>
              <TableCell>
                <TableActions>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={syncingId === u.id}
                    onClick={() => void syncModels(u.id)}
                  >
                    {syncingId === u.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    同步
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="健康检查"
                    onClick={() => void health(u.id)}
                  >
                    <HeartPulse className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="删除"
                    onClick={() => void removeOneUpstream(u.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableActions>
              </TableCell>
            </TableRow>
          ))}
          {upstreams.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                暂无上游。选择提供商并填写 API Key / 地址后，可从上游同步模型。
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-4xl"
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle>{edit ? "编辑上游" : "新建上游"}</SheetTitle>
            <SheetDescription>
              {edit
                ? "修改连接配置，并管理该上游提供的模型。"
                : "选择提供商类型并填写连接信息。"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-4">
            <div className="space-y-3">
              <div>
                <Label>名称</Label>
                <Input
                  className="mt-1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {!edit ? (
                <div>
                  <Label>类型</Label>
                  <div className="mt-1">
                    <SearchableSelect
                      items={protocolItems}
                      value={protocol}
                      onValueChange={(v) => {
                        if (!v) return;
                        setProtocol(v);
                        setBaseUrl(defaultBaseUrlFor(v, region));
                      }}
                      placeholder="选择提供商"
                      searchPlaceholder="搜索提供商…"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <Label>类型</Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {edit.meta?.name ?? edit.protocol}
                  </p>
                </div>
              )}

              {visibleFields.has("region") ? (
                <div>
                  <Label>区域</Label>
                  <Select
                    value={region}
                    onValueChange={(v) => {
                      if (v == null) return;
                      setRegion(v);
                      setBaseUrl(defaultBaseUrlFor(protocol, v));
                    }}
                    items={REGION_ITEMS}
                  >
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REGION_ITEMS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div>
                <Label>API 地址</Label>
                <Input
                  className="mt-1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    defaultBaseUrlFor(protocol, region) || "https://api.example.com/v1"
                  }
                  required
                />
              </div>

              {visibleFields.has("apiKey") ? (
                <div>
                  <Label>API Key</Label>
                  <Input
                    className="mt-1"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={edit ? "留空则保持原值" : undefined}
                  />
                </div>
              ) : null}

              {visibleFields.has("apiVersion") ? (
                <div>
                  <Label>Azure API Version</Label>
                  <Input
                    className="mt-1"
                    value={apiVersion}
                    onChange={(e) => setApiVersion(e.target.value)}
                  />
                </div>
              ) : null}

              {visibleFields.has("deploymentId") ? (
                <div>
                  <Label>默认 Deployment（可选）</Label>
                  <Input
                    className="mt-1"
                    value={deploymentId}
                    onChange={(e) => setDeploymentId(e.target.value)}
                  />
                </div>
              ) : null}

              {visibleFields.has("anthropicVersion") ? (
                <div>
                  <Label>Anthropic Version</Label>
                  <Input
                    className="mt-1"
                    value={anthropicVersion}
                    onChange={(e) => setAnthropicVersion(e.target.value)}
                  />
                </div>
              ) : null}

              {visibleFields.has("rerankBaseUrl") ? (
                <div>
                  <Label>Rerank Base URL（可选）</Label>
                  <Input
                    className="mt-1"
                    value={rerankBaseUrl}
                    onChange={(e) => setRerankBaseUrl(e.target.value)}
                  />
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  关闭
                </Button>
                <Button disabled={busy || !name.trim()} onClick={() => void save()}>
                  {edit ? "保存连接" : "创建"}
                </Button>
              </div>
            </div>

            {edit ? (
              <div className="space-y-3 border-t border-border pt-4">
                <UpstreamModelSetup upstreamId={edit.id} />
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
