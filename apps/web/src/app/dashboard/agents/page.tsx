"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import {
  fetchAgents,
  type AgentListItem,
} from "@/lib/agents";
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
import { cn } from "@/lib/utils";

/** 名称最重要，其次 slug，最后描述 */
const AGENT_KEYS = [
  { name: "name", weight: 3 },
  { name: "slug", weight: 2 },
  { name: "description", weight: 1 },
];

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
        json: {
          name: name.trim(),
          createApiKey: false,
        },
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

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Agents"
        actions={
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
        }
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="mb-3 text-sm text-muted-foreground">暂无 Agent</p>
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
        </div>
      ) : (
        <>
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
              <Link
                key={a.id}
                href={`/dashboard/agents/${a.id}/overview`}
                className={cn(
                  "group flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
                  "surface-interactive hover:border-foreground/15",
                )}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium group-hover:underline underline-offset-2">
                      {a.name}
                    </div>
                    <code className="block truncate text-[10px] text-muted-foreground">
                      {a.slug}
                    </code>
                    {a.description ? (
                      <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {a.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              </Link>
              ))}
            </div>
          )}
        </>
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
