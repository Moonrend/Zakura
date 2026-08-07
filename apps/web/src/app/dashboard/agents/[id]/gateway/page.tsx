"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  getCloudConfig,
  listChatModels,
  saveCloudConfig,
  type ChatModelOption,
} from "@/lib/cloud-agent";
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsHeader, SettingsRow, SettingsSection, TableActions } from "@/components/settings-shell";

/** Gateway Key 固定具备完整代理权限，不按 models/chat 拆分。 */
const GATEWAY_SCOPES = ["gateway:models", "gateway:chat"] as const;

type GatewayKey = {
  id: string;
  name: string;
  keyPrefix: string;
  agentId: string | null;
  scopes: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

type ConnectMeta = {
  publicBaseUrl: string;
};

type ModelMapRow = { id: string; from: string; to: string };

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "从未";
}

function formatExpiry(value: string | null) {
  return value ? new Date(value).toLocaleString() : "永不过期";
}

function mapToRows(map: Record<string, string> | undefined): ModelMapRow[] {
  if (!map) return [];
  return Object.entries(map).map(([from, to], i) => ({
    id: `${i}-${from}`,
    from,
    to,
  }));
}

function rowsToMap(rows: ModelMapRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const from = row.from.trim();
    const to = row.to.trim();
    if (from && to) map[from] = to;
  }
  return map;
}

function CopyButton({
  value,
  label = "复制",
  size = "sm",
  variant = "outline",
}: {
  value: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "default";
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label}已复制`);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("复制失败，请手动选择");
    }
  }

  return (
    <Button type="button" size={size} variant={variant} onClick={() => void copy()}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : label}
    </Button>
  );
}

export default function AgentGatewayPage() {
  const { id } = useParams<{ id: string }>();
  const { agent, loading: agentLoading } = useAgentDetail();
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("gateway");
  const [expiry, setExpiry] = useState("never");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [model, setModel] = useState("");
  const [modelRouteId, setModelRouteId] = useState<string | null>(null);
  const [autoTitle, setAutoTitle] = useState(true);
  const [mapRows, setMapRows] = useState<ModelMapRow[]>([]);
  const mapRowsRef = useRef(mapRows);
  mapRowsRef.current = mapRows;
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [savingMap, setSavingMap] = useState(false);

  const load = useCallback(async () => {
    try {
      const [keyRows, meta, cfg, models] = await Promise.all([
        api<GatewayKey[]>("/api/api-keys"),
        api<ConnectMeta>("/api/connect"),
        getCloudConfig(id),
        listChatModels(),
      ]);
      setKeys(keyRows.filter((key) => key.agentId === id));
      setPublicBaseUrl(meta.publicBaseUrl.replace(/\/$/, ""));
      setModel(cfg.cloud.model ?? "");
      setModelRouteId(cfg.cloud.modelRouteId ?? null);
      setAutoTitle(cfg.cloud.autoTitle !== false);
      setMapRows(mapToRows(cfg.cloud.gatewayModelMap));
      setChatModels(models);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const gatewayBaseUrl = publicBaseUrl ? `${publicBaseUrl}/v1` : "/v1";

  const modelItems = useMemo<ModelRouteSelectorItem[]>(
    () =>
      chatModels.map((m) => ({
        value: m.alias,
        label: m.name || m.alias,
        hint: m.providers.map((p) => p.name).join(" / ") || m.upstream,
        providers: m.providers,
        reasoning: m.reasoning,
        reasoningLevels: m.reasoningLevels,
        defaultReasonLevel: m.defaultReasonLevel,
      })),
    [chatModels],
  );

  const displayModel = model || chatModels.find((m) => m.isDefault)?.alias || "";

  function openCreate() {
    setRawKey(null);
    setName("gateway");
    setExpiry("never");
    setOpen(true);
  }

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const expiresAt =
        expiry === "never"
          ? null
          : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
      const result = await api<{ rawKey: string }>("/api/api-keys", {
        method: "POST",
        json: {
          name: name.trim() || "gateway",
          agentId: id,
          scopes: [...GATEWAY_SCOPES],
          expiresAt,
        },
      });
      setRawKey(result.rawKey);
      await load();
      toast.success("Gateway Key 已创建");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(key: GatewayKey) {
    if (!window.confirm(`撤销「${key.name}」？使用它的客户端将立即无法访问。`)) return;
    try {
      await api(`/api/api-keys/${key.id}`, { method: "DELETE" });
      setKeys((current) => current.filter((item) => item.id !== key.id));
      toast.success("Key 已撤销");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveModelSelection(alias: string, routeId: string | null) {
    setModel(alias);
    setModelRouteId(routeId);
    try {
      await saveCloudConfig(id, { model: alias || null, modelRouteId: routeId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveAutoTitle(value: boolean) {
    setAutoTitle(value);
    try {
      await saveCloudConfig(id, { autoTitle: value });
    } catch (err) {
      setAutoTitle(!value);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function persistModelMap(rows: ModelMapRow[]) {
    setSavingMap(true);
    try {
      const map = rowsToMap(rows);
      await saveCloudConfig(id, {
        gatewayModelMap: Object.keys(map).length ? map : null,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setSavingMap(false);
    }
  }

  function addMapRow() {
    setMapRows((prev) => [...prev, { id: `new-${Date.now()}`, from: "", to: "" }]);
  }

  function updateMapRow(rowId: string, patch: Partial<Pick<ModelMapRow, "from" | "to">>) {
    setMapRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  }

  function commitMapRows() {
    void persistModelMap(mapRowsRef.current);
  }

  function removeMapRow(rowId: string) {
    const next = mapRowsRef.current.filter((row) => row.id !== rowId);
    setMapRows(next);
    void persistModelMap(next);
  }

  if (agentLoading || loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (!agent) {
    return <p className="text-sm text-muted-foreground">Agent 不存在或无权访问。</p>;
  }

  const createKeyButton = (
    <Button size="sm" onClick={openCreate}>
      <Plus className="size-4" />
      创建 Key
    </Button>
  );

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="AI Gateway"
        description="OpenAI 兼容代理。客户端使用 Base URL + 下方 Key 调用 /v1。"
      />

      <SettingsSection title="接入">
        <div className="space-y-1.5">
          <Label htmlFor="gateway-base-url" className="text-xs text-muted-foreground">
            Base URL
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="gateway-base-url"
              readOnly
              value={gatewayBaseUrl}
              className="font-mono text-xs"
            />
            <CopyButton value={gatewayBaseUrl} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            填 Base URL + Key 即可。Claude Code / Codex 等自带 session 头会按会话归并；
            其它客户端按 user 消息历史对齐最近会话。
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        title="API Keys"
        description="Key 绑定本 Agent，创建后只显示一次原文；撤销立即失效。"
        action={keys.length ? createKeyButton : undefined}
      >
        {keys.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>前缀</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead>过期</TableHead>
                  <TableHead>创建</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <code className="text-xs text-muted-foreground">{key.keyPrefix}…</code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(key.lastUsedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatExpiry(key.expiresAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(key.createdAt)}
                    </TableCell>
                    <TableCell>
                      <TableActions>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          title="撤销 Key"
                          onClick={() => void revokeKey(key)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableActions>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-muted-foreground">还没有 Key。创建后即可用外部客户端访问此 Agent。</p>
            {createKeyButton}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="模型"
        description="客户端未指定 model 时使用默认模型；转发表做 O(1) 名称替换，适合 Codex review 等别名。"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">默认模型</Label>
            <ModelRouteSelector
              items={modelItems}
              value={displayModel}
              routeId={modelRouteId}
              onSelectionChange={(alias, routeId) => {
                if (!alias) return;
                void saveModelSelection(alias, routeId);
              }}
              disabled={chatModels.length === 0}
              placeholder={chatModels.length === 0 ? "暂无模型" : "选择模型"}
              className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
            />
          </div>

          <SettingsRow
            label="自动标题"
            description="Gateway 会话首轮结束后由后台生成标题，不拖慢响应。"
            htmlFor="gateway-auto-title"
          >
            <Switch
              id="gateway-auto-title"
              checked={autoTitle}
              onCheckedChange={(v) => void saveAutoTitle(Boolean(v))}
            />
          </SettingsRow>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">模型名转发</p>
                <p className="text-xs text-muted-foreground">
                  客户端请求名 → 实际路由名。例：gpt-5.1-codex → gpt-5.1
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addMapRow} disabled={savingMap}>
                <Plus className="size-3.5" />
                添加
              </Button>
            </div>
            {mapRows.length ? (
              <div className="space-y-2">
                {mapRows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <Input
                      value={row.from}
                      placeholder="客户端模型名"
                      className="font-mono text-xs"
                      onChange={(e) => updateMapRow(row.id, { from: e.target.value })}
                      onBlur={commitMapRows}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">→</span>
                    <Input
                      value={row.to}
                      placeholder="实际模型名"
                      className="font-mono text-xs"
                      onChange={(e) => updateMapRow(row.id, { to: e.target.value })}
                      onBlur={commitMapRows}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="删除"
                      onClick={() => removeMapRow(row.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">未配置转发，客户端 model 原样路由。</p>
            )}
          </div>
        </div>
      </SettingsSection>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rawKey ? "Key 已创建" : "创建 Gateway Key"}</DialogTitle>
            <DialogDescription>
              {rawKey
                ? "原文只显示这一次，请立即复制保存。"
                : `绑定到 ${agent.name}，可访问模型列表与 Chat Completions。`}
            </DialogDescription>
          </DialogHeader>
          {rawKey ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <code className="block break-all font-mono text-xs leading-5">{rawKey}</code>
              </div>
              <DialogFooter>
                <CopyButton value={rawKey} label="复制 Key" />
                <Button onClick={() => setOpen(false)}>完成</Button>
              </DialogFooter>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={(e) => void createKey(e)}>
              <div className="space-y-2">
                <Label htmlFor="gateway-key-name">名称</Label>
                <Input
                  id="gateway-key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="gateway"
                />
              </div>
              <div className="space-y-2">
                <Label>有效期</Label>
                <Select
                  value={expiry}
                  onValueChange={(v) => {
                    if (v) setExpiry(v);
                  }}
                  items={[
                    { value: "never", label: "永不过期" },
                    { value: "7", label: "7 天" },
                    { value: "30", label: "30 天" },
                    { value: "90", label: "90 天" },
                    { value: "365", label: "1 年" },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">永不过期</SelectItem>
                    <SelectItem value="7">7 天</SelectItem>
                    <SelectItem value="30">30 天</SelectItem>
                    <SelectItem value="90">90 天</SelectItem>
                    <SelectItem value="365">1 年</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                  创建
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
