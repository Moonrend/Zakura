"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Loader2,
  MessageSquare,
  Plus,
  Settings2,
  ArrowUpRight,
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
import { PageLoading } from "@/components/ui/progress-linear";
import { NoSearchResult, SearchField } from "@/components/ui/search-field";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { chatAgentHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FluidItem, FluidList } from "@/components/ui/fluid-hover";

const AGENT_KEYS = [
  { name: "name", weight: 3 },
  { name: "slug", weight: 2 },
  { name: "description", weight: 1 },
];

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

const ACTION_LINK = cn(
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground",
  "transition-[background-color,color,transform] duration-150 ease-fluid",
  "hover:bg-hover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
  "press",
);

function AgentCard({ agent }: { agent: AgentListItem }) {
  const state = workspaceState(agent);
  const initial = agent.name.trim().slice(0, 1).toUpperCase() || "A";

  return (
    <FluidItem>
      <div className="group relative flex items-center gap-3 rounded-xl bg-card p-3 shadow-surface-2 sm:h-full sm:min-h-[10rem] sm:flex-col sm:items-stretch sm:p-4">
        <Link
          href={`/dashboard/agents/${agent.id}/overview`}
          className="absolute inset-0 z-[1] rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-label={`${agent.name} 概览`}
        />

        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium">
          {initial}
        </span>

        <div className="min-w-0 flex-1 sm:mt-auto sm:pt-6">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="truncate text-sm font-medium tracking-tight">{agent.name}</h3>
            <span className="shrink-0 text-xs text-muted-foreground sm:hidden">{state.label}</span>
          </div>
          {agent.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground sm:mt-1 sm:line-clamp-2 sm:leading-relaxed">
              {agent.description}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{agent.slug}</p>
          )}
        </div>

        <span className="absolute top-4 right-4 hidden text-xs text-muted-foreground sm:block">
          {state.label}
        </span>

        <div
          className={cn(
            "relative z-[2] hidden items-center gap-0.5 sm:flex",
            "opacity-0 transition-opacity duration-150 ease-fluid",
            "group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <Link href={chatAgentHref(agent.id)} className={ACTION_LINK} title="对话">
            <MessageSquare className="size-3.5" />
          </Link>
          <Link href={`/dashboard/agents/${agent.id}/settings`} className={ACTION_LINK} title="设置">
            <Settings2 className="size-3.5" />
          </Link>
          <Link href={`/dashboard/agents/${agent.id}/overview`} className={ACTION_LINK} title="详情">
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </FluidItem>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl bg-muted">
        <Plus className="size-5 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <p className="text-base font-medium">还没有 Agent</p>
      <p className="mx-auto mt-1.5 max-w-xs text-center text-sm text-muted-foreground">
        创建第一个 Agent，给它工具、记忆和工作区。
      </p>
      <Button size="sm" className="mt-6" onClick={onNew}>
        <Plus />
        新建
      </Button>
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

  const summary = useMemo(() => {
    if (!list.length) return null;
    const running = list.filter(
      (a) => workspaceState(a).tone === "ready",
    ).length;
    const failing = list.filter((a) => workspaceState(a).tone === "error").length;
    const parts = [];
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
      新建
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
        <PageLoading />
      ) : list.length === 0 ? (
        <EmptyState
          onNew={() => {
            resetCreate();
            setOpen(true);
          }}
        />
      ) : (
        <div className="space-y-5">
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
            <FluidList
              axis="xy"
              gapClick={false}
              className="grid gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4"
              highlightClassName="rounded-xl"
            >
              {filtered.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </FluidList>
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
            <DialogTitle>新建</DialogTitle>
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
                你可以随时修改
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
