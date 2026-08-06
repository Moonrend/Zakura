"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  buildConversationTurns,
  forkCloudSession,
  getCloudSession,
  listGatewaySessions,
  subscribeCloudEvents,
} from "@/lib/cloud-agent";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { ChatMessages } from "@/components/chat/chat-messages";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsHeader, SettingsSection, TableActions } from "@/components/settings-shell";
import { cn } from "@/lib/utils";

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

type GatewaySession = Awaited<ReturnType<typeof listGatewaySessions>>["sessions"][number];
type GatewayEvent = Awaited<ReturnType<typeof getCloudSession>>["events"][number];

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "从未";
}

function formatExpiry(value: string | null) {
  return value ? new Date(value).toLocaleString() : "永不过期";
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
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<GatewayEvent[]>([]);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("gateway");
  const [expiry, setExpiry] = useState("never");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    const sessionRows = await listGatewaySessions(id);
    setSessions(sessionRows.sessions);
    return sessionRows.sessions;
  }, [id]);

  const load = useCallback(async () => {
    try {
      const [keyRows, meta] = await Promise.all([
        api<GatewayKey[]>("/api/api-keys"),
        api<ConnectMeta>("/api/connect"),
      ]);
      setKeys(keyRows.filter((key) => key.agentId === id));
      setPublicBaseUrl(meta.publicBaseUrl.replace(/\/$/, ""));
      await refreshSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, refreshSessions]);

  useEffect(() => {
    void load();
  }, [load]);

  // 列表实时：Gateway 新建/更新会话
  useEffect(() => {
    return subscribePlatformEvents(
      (ev) => {
        if (ev.type !== "cloud_session_changed") return;
        if (ev.agentId !== id) return;
        void refreshSessions().catch(() => undefined);
      },
      () => {
        void refreshSessions().catch(() => undefined);
      },
    );
  }, [id, refreshSessions]);

  const mergeEvent = useCallback((ev: GatewayEvent) => {
    setSelectedEvents((prev) => {
      if (prev.some((e) => e.id === ev.id || e.seq === ev.seq)) return prev;
      return [...prev, ev].sort((a, b) => a.seq - b.seq);
    });
    if (ev.seq > seqRef.current) seqRef.current = ev.seq;
  }, []);

  // 选中会话内容实时
  useEffect(() => {
    if (!selectedSessionId) return;
    let unsub = subscribeCloudEvents(id, selectedSessionId, seqRef.current, {
      onEvent: mergeEvent,
      onError: (msg) => console.warn("[gateway sse]", msg),
    });
    const resub = () => {
      unsub();
      unsub = subscribeCloudEvents(id, selectedSessionId, seqRef.current, {
        onEvent: mergeEvent,
      });
    };
    const onVis = () => {
      if (document.visibilityState === "visible") resub();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [id, selectedSessionId, mergeEvent]);

  const gatewayBaseUrl = publicBaseUrl ? `${publicBaseUrl}/v1` : "/v1";
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const turns = useMemo(() => buildConversationTurns(selectedEvents), [selectedEvents]);

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

  async function openSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    setSessionBusy(true);
    try {
      const result = await getCloudSession(id, sessionId);
      setSelectedEvents(result.events);
      seqRef.current = result.events.reduce((max, ev) => Math.max(max, ev.seq), 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionBusy(false);
    }
  }

  async function forkSession(session: GatewaySession) {
    try {
      const result = await forkCloudSession(id, session.id, `${session.title} · Fork`);
      if (!result.session) throw new Error("Fork 成功，但无法读取新会话");
      window.location.href = `/chat?agent=${id}&session=${result.session.id}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
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
            其它客户端按 user 消息历史对齐最近会话。云端工具在服务端执行，不会甩回本地。
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
        title="Gateway 会话"
        description="外部请求产生的会话只读；继续对话请 Fork 到 Chat。"
      >
        {!sessions.length ? (
          <p className="text-sm text-muted-foreground">暂无会话。</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[minmax(14rem,0.36fr)_minmax(0,1fr)]">
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {sessions.map((session) => {
                const active = selectedSessionId === session.id;
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={cn(
                      "block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                      active && "bg-muted/60",
                    )}
                    onClick={() => void openSession(session.id)}
                  >
                    <span className="block truncate text-sm font-medium">{session.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {session.model || "未指定模型"} · {formatDate(session.updatedAt)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="min-h-52 rounded-md border border-border p-3">
              {sessionBusy ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-4/5" />
                </div>
              ) : selectedSession ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">{selectedSession.title}</h3>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {selectedSession.model || "未指定模型"}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void forkSession(selectedSession)}>
                      <ExternalLink className="size-3.5" />
                      Fork 到 Chat
                    </Button>
                  </div>
                  <div className="max-h-[28rem] overflow-y-auto border-t border-border pt-1">
                    {turns.length ? (
                      <ChatMessages
                        turns={turns}
                        runActive={Boolean(selectedSession.activeRunId)}
                        activeRunId={selectedSession.activeRunId}
                        agentName={agent.name}
                        canAct={false}
                        onRegenerate={() => undefined}
                        onEditSend={() => undefined}
                        onSelectVariant={() => undefined}
                        onSelectBranch={() => undefined}
                      />
                    ) : (
                      <p className="px-3 py-4 text-sm text-muted-foreground">该会话暂无可展示消息。</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">选择左侧会话查看内容。</p>
              )}
            </div>
          </div>
        )}
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
