"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Brain, HardDrive, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import {
  fetchAgents,
  getWorkspaceStatus,
  needsContainer,
  statusVariant,
  workspaceStatusLabel,
  type AgentListItem,
} from "@/lib/agents";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function AgentsListPage() {
  const router = useRouter();
  const [list, setList] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setCreatedKey(null);
    setCreatedUrl(null);
    setCreatedId(null);
  }

  async function create() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      const res = await api<
        AgentListItem & {
          apiKey?: { rawKey?: string } | null;
          mcpAgentUrl: string;
        }
      >("/api/agents", {
        method: "POST",
        json: {
          name: name.trim(),
          createApiKey: true,
        },
      });
      setCreatedKey(res.apiKey?.rawKey ?? null);
      setCreatedUrl(res.mcpAgentUrl);
      setCreatedId(res.id);
      await load(true);
      if (!res.apiKey?.rawKey) {
        setOpen(false);
        resetCreate();
        router.push(`/chat?agent=${res.id}`);
      }
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => {
            const ws = getWorkspaceStatus(a);
            const hasComputer = needsContainer(a);
            const caps = [
              hasComputer ? "电脑" : null,
              a.enableMemory ? "记忆" : null,
            ].filter(Boolean) as string[];

            return (
              <Link
                key={a.id}
                href={`/dashboard/agents/${a.id}/general`}
                className={cn(
                  "group flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
                  "transition-colors hover:border-foreground/20 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex items-start gap-2.5">
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
                    </div>
                  </div>
                  {hasComputer ? (
                    <Badge variant={statusVariant(ws)} className="shrink-0">
                      {workspaceStatusLabel(ws)}
                    </Badge>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {hasComputer ? (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <HardDrive className="size-3" />
                      电脑
                    </Badge>
                  ) : null}
                  {a.enableMemory ? (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <Brain className="size-3" />
                      记忆
                    </Badge>
                  ) : null}
                  {caps.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">无扩展能力</span>
                  ) : null}
                </div>
              </Link>
            );
          })}
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
            <DialogTitle>{createdKey ? "API Key 已创建" : "新建 Agent"}</DialogTitle>
          </DialogHeader>
          {createdKey && createdId ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">仅显示一次</p>
              <pre className="max-h-56 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed border border-border">
                {JSON.stringify(
                  {
                    mcpServers: {
                      zakura: {
                        url: createdUrl,
                        headers: { Authorization: `Bearer ${createdKey}` },
                      },
                    },
                  },
                  null,
                  2,
                )}
              </pre>
              <DialogFooter>
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setOpen(false);
                    const nextId = createdId;
                    resetCreate();
                    router.push(`/dashboard/agents/${nextId}/general`);
                  }}
                >
                  进入设置
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">名称</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 research-bot"
                  autoFocus
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
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
