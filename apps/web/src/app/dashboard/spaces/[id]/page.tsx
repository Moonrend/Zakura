"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Server, Trash2 } from "lucide-react";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { FluidList } from "@/components/ui/fluid-hover";
import { api } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  deleteSpace,
  fetchSpace,
  updateSpace,
  type SpaceItem,
} from "@/lib/spaces";
import { chatAgentHref } from "@/lib/nav";

function statusTone(status: string | undefined): "default" | "destructive" | "secondary" {
  if (status === "ready") return "default";
  if (status === "error" || status === "failed") return "destructive";
  return "secondary";
}

export default function SpaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [space, setSpace] = useState<SpaceItem | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [s, agentRows] = await Promise.all([fetchSpace(id), fetchAgents()]);
        setSpace(s);
        setAgents(agentRows.filter((a) => (a as AgentListItem & { spaceId?: string }).spaceId === s.id));
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) setNotFound(true);
        else toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function openSettings() {
    if (!space) return;
    setEditName(space.name);
    setEditDesc(space.description);
    setSettingsOpen(true);
  }

  async function saveSettings() {
    if (!space || !editName.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      const updated = await updateSpace(space.id, {
        name: editName.trim(),
        description: editDesc.trim(),
      });
      setSpace(updated);
      setSettingsOpen(false);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSpace() {
    if (!space) return;
    setBusy(true);
    try {
      await deleteSpace(space.id);
      router.push("/dashboard/spaces");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function createAgent() {
    if (!agentName.trim()) {
      toast.error("请填写名称");
      return;
    }
    setCreateBusy(true);
    try {
      const res = await api<AgentListItem>("/api/agents", {
        method: "POST",
        json: { name: agentName.trim(), spaceId: id, createApiKey: false },
      });
      setCreateOpen(false);
      setAgentName("");
      router.push(`/dashboard/spaces/${id}/agents/${res.id}/overview`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }

  if (loading) return <PageLoading />;
  if (notFound || !space) {
    return (
      <div className="space-y-4">
        <SettingsHeader title="Space" />
        <Empty title="未找到该空间">
          <EmptyTitle>未找到该空间</EmptyTitle>
          <EmptyDescription>可能已被删除</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title={space.name}
        description={space.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openSettings}>
              重命名
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              添加 Agent
            </Button>
          </div>
        }
      />

      {/* 共享电脑状态 */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Server className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">共享电脑</span>
          <Badge variant={statusTone(space.workspaceStatus)}>
            {space.workspaceStatus}
          </Badge>
          <span className="text-xs text-muted-foreground">
            kind: {space.workspaceKind}
            {space.runtimeNodeId ? ` · node: ${space.runtimeNodeId}` : ""}
            {space.workspaceImage ? ` · image: ${space.workspaceImage}` : ""}
          </span>
        </div>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {space.workspaceHostPath}
        </p>
      </div>

      {/* 成员 agent 列表 */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          成员 Agent（{agents.length}）
        </h2>
        {agents.length === 0 ? (
          <Empty>
            <EmptyTitle>还没有 Agent</EmptyTitle>
            <EmptyDescription>点击右上角「添加 Agent」创建</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y rounded-xl border bg-card">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <Link
                  href={`/dashboard/spaces/${id}/agents/${a.id}/overview`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm">
                    {a.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.name}</span>
                    {a.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.description}
                      </span>
                    ) : null}
                  </span>
                </Link>
                <Badge variant={statusTone(a.workspaceStatus)}>
                  {a.workspaceStatus ?? "ready"}
                </Badge>
                <Button size="sm" variant="ghost" render={<a href={chatAgentHref(a.id)} />}>
                  会话
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 设置 Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>空间设置</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="space-edit-name">名称</Label>
              <Input
                id="space-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-edit-desc">描述</Label>
              <Textarea
                id="space-edit-desc"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
                删除空间
              </Button>
              <Button disabled={busy} onClick={() => void saveSettings()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除空间？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            将级联删除空间内的所有 Agent 及其数据，此操作不可撤销。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeSpace()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加 Agent */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加 Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-create-name">名称</Label>
              <Input
                id="agent-create-name"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="例如 research-bot"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !createBusy) void createAgent();
                }}
              />
            </div>
            <DialogFooter>
              <Button className="w-full" disabled={createBusy} onClick={() => void createAgent()}>
                {createBusy ? <Loader2 className="animate-spin" /> : null}
                {createBusy ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
