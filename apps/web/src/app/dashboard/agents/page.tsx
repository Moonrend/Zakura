"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

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
        router.push(`/dashboard/agents/${res.id}/general`);
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
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>环境</TableHead>
              <TableHead>能力</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((a) => {
              const ws = getWorkspaceStatus(a);
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/agents/${a.id}/general`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="text-[11px] text-muted-foreground">{a.slug}</code>
                  </TableCell>
                  <TableCell>
                    {needsContainer(a) ? (
                      <Badge variant={statusVariant(ws)}>
                        {workspaceStatusLabel(ws)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[
                      needsContainer(a) ? "电脑" : null,
                      a.enableMemory ? "记忆" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {!list.length ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  暂无 Agent
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
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
