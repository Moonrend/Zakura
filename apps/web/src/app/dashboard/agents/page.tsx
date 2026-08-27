"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  Brain,
  Loader2,
  MessageSquare,
  Monitor,
  Plus,
  Server,
  Settings2,
} from "lucide-react";
import { api } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { NoSearchResult, SearchField } from "@/components/ui/search-field";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { chatAgentHref } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** 名称最重要，其次 slug，最后描述 */
const AGENT_KEYS = [
  { name: "name", weight: 3 },
  { name: "slug", weight: 2 },
  { name: "description", weight: 1 },
];

/**
 * 工作区状态 → 一句人话 + 一个圆点色。
 *
 * 只用扁平小圆点，不加光晕/呼吸动画：状态是一个很小的信号，
 * 把二元状态做成会发光的宝石属于过度设计，而且一屏十几个一起脉动会让页面永不安静。
 */
function workspaceState(agent: AgentListItem): {
  label: string;
  tone: "ready" | "busy" | "error" | "idle";
} {
  if (agent.lastError) return { label: "有错误", tone: "error" };
  switch (agent.workspaceStatus) {
    case "ready":
    case "running":
      return { label: "运行中", tone: "ready" };
    case "starting":
    case "provisioning":
      return { label: "启动中", tone: "busy" };
    case "error":
    case "failed":
      return { label: "启动失败", tone: "error" };
    case "stopped":
      return { label: "已停止", tone: "idle" };
    default:
      return { label: agent.needsContainer ? "未启动" : "就绪", tone: "idle" };
  }
}

const TONE_DOT: Record<string, string> = {
  ready: "bg-success",
  busy: "bg-warning",
  error: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

function AgentCard({ agent }: { agent: AgentListItem }) {
  const state = workspaceState(agent);
  const capabilities = [
    agent.enableComputer ? { icon: Monitor, label: "电脑环境" } : null,
    agent.enableMemory ? { icon: Brain, label: "记忆" } : null,
    agent.runtimeNodeId ? { icon: Server, label: "远程节点" } : null,
  ].filter((c): c is { icon: typeof Monitor; label: string } => c !== null);

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-lg border border-border bg-card",
        "transition-colors duration-150 hover:border-foreground/20",
      )}
    >
      {/* 整卡可点：覆盖一层链接，卡内的其它链接靠 z-10 浮在它上面 */}
      <Link
        href={`/dashboard/agents/${agent.id}/overview`}
        className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={`${agent.name} 概览`}
      />

      <div className="flex min-w-0 items-start gap-3 p-4">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          {/* 名称明显大于元信息：卡片的层级同样来自字号，而不是灰度 */}
          <div className="truncate text-base font-medium leading-tight">
            {agent.name}
          </div>
          <code className="mt-0.5 block truncate text-xs text-muted-foreground">
            {agent.slug}
          </code>
          {agent.description ? (
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {agent.description}
            </p>
          ) : null}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", TONE_DOT[state.tone])}
          />
          {state.label}
        </span>
      </div>

      {/* 能力与操作分区：与上方主信息之间留出更大的间距，
          分隔线贴合卡片边缘，避免圆角处描边断裂 */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {capabilities.length ? (
            capabilities.map(({ icon: Icon, label }) => (
              <span key={label} className="inline-flex items-center gap-1">
                <Icon className="size-3.5" />
                {label}
              </span>
            ))
          ) : (
            <span>基础对话</span>
          )}
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            nativeButton={false}
            render={<Link href={chatAgentHref(agent.id)} />}
          >
            <MessageSquare className="size-3.5" />
            对话
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="设置"
            className="size-7 p-0"
            nativeButton={false}
            render={<Link href={`/dashboard/agents/${agent.id}/settings`} />}
          >
            <Settings2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsListPage() {
  const router = useRouter();
  const [list, setList] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useFuzzySearch(list, q, { keys: AGENT_KEYS });

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setList(await fetchAgents());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 只报真正测到的数字，且只在有意义时出现——不凑一排整数当装饰。
  const summary = useMemo(() => {
    if (!list.length) return null;
    const running = list.filter(
      (a) => workspaceState(a).tone === "ready",
    ).length;
    const failing = list.filter((a) => workspaceState(a).tone === "error").length;
    const parts = [`${list.length} 个 Agent`];
    if (running) parts.push(`${running} 个运行中`);
    if (failing) parts.push(`${failing} 个有错误`);
    return parts.join(" · ");
  }, [list]);

  function resetCreate() {
    setName("");
  }

  async function create() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      const res = await api<AgentListItem>("/api/agents", {
        method: "POST",
        json: { name: name.trim(), createApiKey: false },
      });
      setOpen(false);
      resetCreate();
      router.push(`/dashboard/agents/${res.id}/overview`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const newButton = (
    <Button
      size="sm"
      onClick={() => {
        resetCreate();
        setOpen(true);
      }}
    >
      <Plus />
      新建 Agent
    </Button>
  );

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Agents"
        description={summary ?? undefined}
        actions={newButton}
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Bot className="size-5" />
          </div>
          <p className="text-base font-medium">还没有 Agent</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
            一个 Agent 拥有自己的工作区、工具与记忆。建好之后可以直接对话，
            也可以接到 MCP、平台或定时任务上。
          </p>
          <div className="mt-5">{newButton}</div>
        </div>
      ) : (
        <div className="space-y-4">
          {list.length > 4 ? (
            <SearchField
              value={q}
              onValueChange={setQ}
              placeholder="搜索名称、slug 或描述"
              className="max-w-sm"
            />
          ) : null}
          {filtered.length === 0 ? (
            <NoSearchResult query={q} />
          ) : (
            <div className="stagger-children grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetCreate();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建 Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">名称</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 research-bot"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void create();
                }}
              />
              <p className="text-xs text-muted-foreground">
                稍后可以改名；slug 由名称生成，用于 API 与 MCP 地址。
              </p>
            </div>
            <DialogFooter>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => void create()}
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                {busy ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
