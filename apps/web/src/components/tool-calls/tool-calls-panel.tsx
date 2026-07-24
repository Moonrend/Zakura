"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
  Search,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type ToolCallItem = {
  id: string;
  apiKeyId: string | null;
  agentId: string | null;
  qualifiedName: string;
  localName: string;
  providerId: string;
  instanceId: string | null;
  argsJson: string;
  resultJson: string;
  isError: boolean;
  durationMs: number;
  createdAt: string;
  agentName?: string | null;
  agentSlug?: string | null;
  apiKeyName?: string | null;
  apiKeyPrefix?: string | null;
};

export type ToolCallStats = {
  total: number;
  errors: number;
  avgDurationMs: number;
  last24h: number;
  byAgent: Array<{ agentId: string | null; agentName: string | null; count: number }>;
  byApiKey: Array<{
    apiKeyId: string | null;
    apiKeyName: string | null;
    keyPrefix: string | null;
    count: number;
  }>;
  byTool: Array<{ qualifiedName: string; count: number; errors: number }>;
};

type KeyOption = { id: string; name: string; keyPrefix: string; agentId?: string | null };
type AgentOption = { id: string; name: string; slug: string };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleString();
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 展开历史 { isError, text } 包装，并美化内层 JSON */
function prettyResultJson(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "isError" in parsed &&
      typeof (parsed as { text?: unknown }).text === "string" &&
      Object.keys(parsed as object).every((k) => k === "isError" || k === "text")
    ) {
      const text = (parsed as { text: string }).text;
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "danger" | "ok";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3",
        tone === "danger" && "ring-destructive/25",
        tone === "ok" && "ring-success/25",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <Icon
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground",
            tone === "danger" && "text-destructive",
            tone === "ok" && "text-success",
          )}
        />
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function CallRow({
  item,
  showAgent,
}: {
  item: ToolCallItem;
  showAgent: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "content-auto border-b last:border-b-0",
        item.isError ? "bg-destructive/5" : "bg-card",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className="mt-0.5 shrink-0">
          {item.isError ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="truncate text-[12px] font-medium">{item.qualifiedName}</code>
            {item.providerId ? (
              <Badge variant="secondary">{item.providerId}</Badge>
            ) : null}
            <Badge variant={item.isError ? "danger" : "success"}>
              {item.isError ? "失败" : "成功"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(item.createdAt)}
            </span>
            <span>{formatDuration(item.durationMs)}</span>
            {showAgent ? (
              item.agentId ? (
                <Link
                  href={`/dashboard/agents/${item.agentId}/tool-calls`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:text-foreground hover:underline"
                >
                  {item.agentName || item.agentSlug || "Agent"}
                </Link>
              ) : (
                <span>租户级</span>
              )
            ) : null}
            <span className="inline-flex items-center gap-1">
              <KeyRound className="h-3 w-3" />
              {item.apiKeyName
                ? `${item.apiKeyName} (${item.apiKeyPrefix}…)`
                : item.apiKeyPrefix
                  ? `${item.apiKeyPrefix}…`
                  : "—"}
            </span>
          </div>
        </div>
      </button>
      {open ? (
        <div className="grid gap-2 border-t bg-muted/30 px-3 py-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">参数</div>
            <pre className="max-h-64 overflow-auto rounded-md border bg-card p-2 text-[11px] leading-relaxed">
              {prettyJson(item.argsJson)}
            </pre>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">结果</div>
            <pre className="max-h-64 overflow-auto rounded-md border bg-card p-2 text-[11px] leading-relaxed">
              {prettyResultJson(item.resultJson)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ToolCallsPanel({
  title = "工具调用",
  agentId,
  showAgentFilter = true,
}: {
  title?: string;
  agentId?: string;
  showAgentFilter?: boolean;
}) {
  const [stats, setStats] = useState<ToolCallStats | null>(null);
  const [items, setItems] = useState<ToolCallItem[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [draftQ, setDraftQ] = useState("");
  const [apiKeyId, setApiKeyId] = useState("all");
  const [filterAgentId, setFilterAgentId] = useState(agentId ?? "all");
  const [status, setStatus] = useState<"all" | "ok" | "error">("all");
  const [keys, setKeys] = useState<KeyOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const limit = 40;

  const listUrl = useMemo(() => {
    const base = agentId ? `/api/agents/${agentId}/tool-calls` : "/api/tool-calls";
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (apiKeyId !== "all") params.set("apiKeyId", apiKeyId);
    if (!agentId && filterAgentId !== "all") params.set("agentId", filterAgentId);
    if (status === "error") params.set("isError", "1");
    if (status === "ok") params.set("isError", "0");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return `${base}?${params}`;
  }, [agentId, q, apiKeyId, filterAgentId, status, offset]);

  const statsUrl = agentId
    ? `/api/agents/${agentId}/tool-calls/stats`
    : filterAgentId !== "all"
      ? `/api/tool-calls/stats?agentId=${encodeURIComponent(filterAgentId)}`
      : "/api/tool-calls/stats";

  const loadMeta = useCallback(async () => {
    const tasks: Promise<unknown>[] = [api<KeyOption[]>("/api/api-keys")];
    if (showAgentFilter && !agentId) {
      tasks.push(api<AgentOption[]>("/api/agents"));
    }
    const [keyRows, agentRows] = (await Promise.all(tasks)) as [
      KeyOption[],
      AgentOption[] | undefined,
    ];
    setKeys(keyRows);
    if (agentRows) setAgents(agentRows);
  }, [agentId, showAgentFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, statsRes] = await Promise.all([
        api<{ items: ToolCallItem[]; total: number }>(listUrl),
        api<ToolCallStats>(statsUrl),
      ]);
      setItems(listRes.items);
      setTotal(listRes.total);
      setStats(statsRes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [listUrl, statsUrl]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    void load();
  }, [load]);

  const errorRate =
    stats && stats.total > 0 ? Math.round((stats.errors / stats.total) * 100) : 0;

  const keyOptions = agentId
    ? keys.filter((k) => k.agentId === agentId || !k.agentId)
    : keys;

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-lg font-semibold tracking-tight">{title}</h1>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="总调用"
          value={stats?.total ?? "—"}
          hint={stats ? `近 24h ${stats.last24h} 次` : undefined}
          icon={Activity}
        />
        <StatCard
          label="失败"
          value={stats?.errors ?? "—"}
          hint={stats ? `错误率 ${errorRate}%` : undefined}
          icon={AlertTriangle}
          tone={stats && stats.errors > 0 ? "danger" : "default"}
        />
        <StatCard
          label="平均耗时"
          value={stats ? formatDuration(stats.avgDurationMs) : "—"}
          icon={Zap}
        />
        <StatCard
          label="热门工具"
          value={stats?.byTool[0]?.qualifiedName?.split("__").pop() ?? "—"}
          hint={
            stats?.byTool[0]
              ? `${stats.byTool[0].count} 次 · 失败 ${stats.byTool[0].errors}`
              : undefined
          }
          icon={Search}
        />
      </div>

      {(stats?.byTool.length || stats?.byApiKey.length) ? (
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">按工具</div>
            <div className="space-y-1.5">
              {(stats?.byTool ?? []).slice(0, 6).map((t) => {
                const max = stats?.byTool[0]?.count || 1;
                const pct = Math.max(4, Math.round((t.count / max) * 100));
                return (
                  <button
                    key={t.qualifiedName}
                    type="button"
                    className="block w-full text-left"
                    onClick={() => {
                      setDraftQ(t.qualifiedName);
                      setQ(t.qualifiedName);
                      setOffset(0);
                    }}
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                      <code className="truncate">{t.qualifiedName}</code>
                      <span className="shrink-0 text-muted-foreground">
                        {t.count}
                        {t.errors ? ` · ${t.errors} 错` : ""}
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                );
              })}
              {!stats?.byTool.length ? (
                <div className="text-[11px] text-muted-foreground">暂无数据</div>
              ) : null}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">按 API Key</div>
            <div className="space-y-1.5">
              {(stats?.byApiKey ?? []).slice(0, 6).map((k, i) => (
                <button
                  key={k.apiKeyId ?? `null-${i}`}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                  onClick={() => {
                    if (k.apiKeyId) {
                      setApiKeyId(k.apiKeyId);
                      setOffset(0);
                    }
                  }}
                >
                  <span className="truncate">
                    {k.apiKeyName || "未知 Key"}
                    {k.keyPrefix ? (
                      <code className="ml-1 text-muted-foreground">{k.keyPrefix}…</code>
                    ) : null}
                  </span>
                  <Badge variant="secondary">{k.count}</Badge>
                </button>
              ))}
              {!stats?.byApiKey.length ? (
                <div className="text-[11px] text-muted-foreground">暂无数据</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-2.5">
        <form
          className="flex min-w-[200px] flex-1 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(draftQ);
            setOffset(0);
          }}
        >
          <Input
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
            placeholder="搜索工具名…"
            className="h-8"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-3.5 w-3.5" />
          </Button>
        </form>

        {showAgentFilter && !agentId ? (
          <Select
            value={filterAgentId}
            onValueChange={(v) => {
              if (v == null) return;
              setFilterAgentId(v);
              setOffset(0);
            }}
            items={[
              { value: "all", label: "全部 Agent" },
              ...agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          >
            <SelectTrigger className="h-8 w-[160px]">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 Agent</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Select
          value={apiKeyId}
          onValueChange={(v) => {
            if (v == null) return;
            setApiKeyId(v);
            setOffset(0);
          }}
          items={[
            { value: "all", label: "全部 Key" },
            ...keyOptions.map((k) => ({
              value: k.id,
              label: `${k.name} (${k.keyPrefix}…)`,
            })),
          ]}
        >
          <SelectTrigger className="h-8 w-[180px]">
            <SelectValue placeholder="API Key" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Key</SelectItem>
            {keyOptions.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.name} ({k.keyPrefix}…)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(v) => {
            if (v == null) return;
            setStatus(v as "all" | "ok" | "error");
            setOffset(0);
          }}
          items={[
            { value: "all", label: "全部状态" },
            { value: "ok", label: "仅成功" },
            { value: "error", label: "仅失败" },
          ]}
        >
          <SelectTrigger className="h-8 w-[120px]">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="ok">仅成功</SelectItem>
            <SelectItem value="error">仅失败</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {loading && !items.length ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">
            暂无调用记录。通过 MCP 客户端调用工具后会出现在这里。
          </div>
        ) : (
          items.map((item) => (
            <CallRow key={item.id} item={item} showAgent={!agentId} />
          ))
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          共 {total} 条 · 当前 {offset + 1}–{Math.min(offset + limit, total) || 0}
        </span>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={offset <= 0 || loading}
            onClick={() => setOffset((o) => Math.max(0, o - limit))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={offset + limit >= total || loading}
            onClick={() => setOffset((o) => o + limit)}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
