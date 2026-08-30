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

const AGENT_KEYS = [
  { name: "name", weight: 3 },
  { name: "slug", weight: 2 },
  { name: "description", weight: 1 },
];

/* ---------------------------------------------------------------------------
 * Deterministic visual identity from a string.
 *
 * Each agent gets a unique abstract CSS background built from layered gradients.
 * The hash drives hue, angle, and shape placement — so the same name always
 * produces the same pattern, but different names look visibly distinct.
 * ------------------------------------------------------------------------- */

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function agentVisual(name: string, id: string): React.CSSProperties {
  const h = hashStr(name + id);
  const hue = h % 360;
  const angle = (h >> 8) % 360;
  const x1 = 20 + ((h >> 4) % 60);
  const y1 = 15 + ((h >> 6) % 55);
  const x2 = 30 + ((h >> 10) % 50);
  const y2 = 40 + ((h >> 12) % 40);
  const spread1 = 25 + ((h >> 3) % 35);
  const spread2 = 20 + ((h >> 7) % 30);

  const variant = h % 5;
  const chroma = 0.035 + ((h >> 5) % 30) * 0.001;

  let bg: string;
  switch (variant) {
    case 0:
      bg = [
        `radial-gradient(ellipse ${spread1}% ${spread1 + 20}% at ${x1}% ${y1}%, oklch(0.38 ${chroma} ${hue}) 0%, transparent 100%)`,
        `radial-gradient(circle ${spread2}% at ${x2}% ${y2}%, oklch(0.28 ${chroma * 0.7} ${(hue + 120) % 360}) 0%, transparent 100%)`,
        `conic-gradient(from ${angle}deg at 50% 50%, oklch(0.16 0 0) 0%, oklch(0.22 ${chroma * 0.3} ${hue}) 25%, oklch(0.14 0 0) 50%, oklch(0.20 ${chroma * 0.4} ${(hue + 180) % 360}) 75%, oklch(0.16 0 0) 100%)`,
      ].join(", ");
      break;
    case 1:
      bg = [
        `repeating-linear-gradient(${angle}deg, transparent 0px, transparent 18px, oklch(0.24 ${chroma * 0.5} ${hue} / 40%) 18px, oklch(0.24 ${chroma * 0.5} ${hue} / 40%) 19px)`,
        `radial-gradient(ellipse 70% 50% at ${x1}% ${y1}%, oklch(0.32 ${chroma} ${hue}) 0%, transparent 80%)`,
        `linear-gradient(${(angle + 90) % 360}deg, oklch(0.14 0 0), oklch(0.20 ${chroma * 0.3} ${(hue + 60) % 360}))`,
      ].join(", ");
      break;
    case 2:
      bg = [
        `radial-gradient(circle at ${x1}% ${y1}%, oklch(0.35 ${chroma} ${hue}) 0%, transparent ${spread1}%)`,
        `radial-gradient(circle at ${100 - x2}% ${100 - y2}%, oklch(0.30 ${chroma * 0.8} ${(hue + 150) % 360}) 0%, transparent ${spread2 + 15}%)`,
        `radial-gradient(circle at 50% 100%, oklch(0.25 ${chroma * 0.5} ${(hue + 90) % 360}) 0%, transparent 50%)`,
        `oklch(0.15 0 0)`,
      ].join(", ");
      break;
    case 3:
      bg = [
        `conic-gradient(from ${angle}deg at ${x1}% ${y1}%, oklch(0.30 ${chroma} ${hue}) 0%, oklch(0.18 0 0) 20%, oklch(0.28 ${chroma * 0.6} ${(hue + 90) % 360}) 40%, oklch(0.16 0 0) 60%, oklch(0.32 ${chroma * 0.8} ${(hue + 200) % 360}) 80%, oklch(0.30 ${chroma} ${hue}) 100%)`,
        `radial-gradient(circle at 50% 50%, transparent 30%, oklch(0.14 0 0 / 60%) 100%)`,
      ].join(", ");
      break;
    default:
      bg = [
        `linear-gradient(${angle}deg, oklch(0.22 ${chroma} ${hue}), oklch(0.14 0 0) 40%, oklch(0.20 ${chroma * 0.7} ${(hue + 180) % 360}))`,
        `radial-gradient(ellipse 60% 80% at ${x1}% ${y1}%, oklch(0.30 ${chroma * 0.5} ${(hue + 60) % 360} / 50%) 0%, transparent 100%)`,
      ].join(", ");
      break;
  }

  return { background: bg };
}

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
  ready: "bg-emerald-400",
  busy: "bg-amber-400",
  error: "bg-red-400",
  idle: "bg-white/25",
};

const ACTION_LINK = cn(
  "inline-flex size-8 items-center justify-center rounded-full",
  "text-white/70 backdrop-blur-md",
  "transition-all duration-150 ease-out-soft",
  "hover:bg-white/20 hover:text-white",
  "focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none",
  "press",
);

function AgentCard({ agent }: { agent: AgentListItem }) {
  const state = workspaceState(agent);
  const visual = agentVisual(agent.name, agent.id);

  return (
    <div
      className={cn(
        "agent-card group relative flex aspect-square flex-col overflow-hidden rounded-2xl",
        "transition-all duration-300 ease-out-soft",
        "hover:scale-[1.02] hover:shadow-[0_8px_40px_oklch(0_0_0/0.35)]",
        "focus-within:scale-[1.02] focus-within:shadow-[0_8px_40px_oklch(0_0_0/0.35)]",
      )}
      style={visual}
    >
      <Link
        href={`/dashboard/agents/${agent.id}/overview`}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
        aria-label={`${agent.name} 概览`}
      />



      <div className="flex-1" />

      {/* Bottom region: name left, hover actions right */}
      <div
        className={cn(
          "relative z-10 flex items-end justify-between gap-2 px-4 pb-4 pt-10",
          "bg-gradient-to-t from-black/65 via-black/30 to-transparent",
        )}
      >
        <h3 className="min-w-0 truncate text-base font-semibold leading-snug tracking-tight text-white drop-shadow-[0_1px_2px_oklch(0_0_0/0.5)]">
          {agent.name}
        </h3>

        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            "translate-y-2 opacity-0 transition-all duration-200 ease-out-soft",
            "group-hover:translate-y-0 group-hover:opacity-100",
            "group-focus-within:translate-y-0 group-focus-within:opacity-100",
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
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div
        className="animate-pop mb-8 flex size-28 items-center justify-center rounded-3xl"
        style={{
          background: [
            "radial-gradient(circle at 35% 35%, oklch(0.35 0.04 260) 0%, transparent 60%)",
            "radial-gradient(circle at 70% 70%, oklch(0.28 0.03 180) 0%, transparent 50%)",
            "oklch(0.16 0 0)",
          ].join(", "),
        }}
      >
        <Plus className="size-10 text-white/50" strokeWidth={1.5} />
      </div>
      <p className="text-lg font-medium">还没有 Agent</p>
      <p className="mx-auto mt-2 max-w-xs text-center text-sm text-muted-foreground">
        创建你的第一个 Agent，赋予它工具、记忆与工作区
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
            <div className="stagger-children grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
