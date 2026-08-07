"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ExternalLink,
  HardDrive,
  Loader2,
  Monitor,
  Play,
  Square,
  Trash2,
  ArrowRightLeft,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  fetchAgentProgress,
  getWorkspaceStatus,
  levelColor,
  needsContainer,
  workspaceStatusLabel,
  type ProgressSnapshot,
} from "@/lib/agents";
import {
  kindLabel,
  listRuntimeNodes,
  statusLabel,
  statusVariant,
  type RuntimeNode,
} from "@/lib/runners";
import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentFileManager } from "@/components/agent-files/file-manager";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { subscribePlatformEvents } from "@/lib/platform-events";

const LOCAL_VALUE = "__local__";

export default function AgentComputerPage() {
  const { confirm } = useConfirmDialog();
  const { id, agent, refresh, patchAgent } = useAgentDetail();
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [envBusy, setEnvBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [wsStatus, setWsStatus] = useState("idle");
  const [createOpen, setCreateOpen] = useState(false);
  const [createNodeId, setCreateNodeId] = useState(LOCAL_VALUE);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [migrateTarget, setMigrateTarget] = useState("");
  const [migrateBusy, setMigrateBusy] = useState(false);
  const [migrateStatus, setMigrateStatus] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, ns] = await Promise.all([refresh({ list: false }), listRuntimeNodes()]);
      if (a) setWsStatus(getWorkspaceStatus(a));
      setNodes(ns);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [refresh]);

  useEffect(() => {
    if (agent) setWsStatus(getWorkspaceStatus(agent));
  }, [agent]);

  useEffect(() => {
    void listRuntimeNodes()
      .then(setNodes)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [id]);

  // 进度经平台事件推送（SSE），只在挂载/重连/收尾时拉快照对齐
  useEffect(() => {
    let alive = true;

    const syncSnapshot = async () => {
      try {
        const res = await fetchAgentProgress(id);
        if (!alive) return;
        setProgress(res.progress);
        setWsStatus(res.workspace.status);
        patchAgent({
          lastError: res.agent.lastError,
          workspace: res.workspace,
        });
      } catch {
        /* ignore */
      }
    };

    void syncSnapshot();
    const unsubscribe = subscribePlatformEvents(
      (ev) => {
        if (ev.type !== "agent_progress" || ev.agentId !== id) return;
        setProgress(ev.snapshot);
        if (ev.snapshot.done) {
          // 收尾：拉一次权威状态（workspace status / lastError）
          void syncSnapshot();
          void refresh({ list: false });
        }
      },
      () => void syncSnapshot(),
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [id, patchAgent, refresh]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progress?.events.length]);

  const currentNode = useMemo(() => {
    if (!agent?.runtimeNodeId) {
      return nodes.find((n) => n.kind === "local") ?? null;
    }
    return nodes.find((n) => n.id === agent.runtimeNodeId) ?? null;
  }, [agent?.runtimeNodeId, nodes]);

  const remoteNodes = useMemo(
    () => nodes.filter((n) => n.kind !== "local"),
    [nodes],
  );

  const hasLocal = useMemo(() => nodes.some((n) => n.kind === "local"), [nodes]);

  useEffect(() => {
    if (hasLocal) return;
    const firstRemote = nodes.find((n) => n.kind !== "local");
    if (firstRemote) setCreateNodeId(firstRemote.id);
  }, [hasLocal, nodes]);

  const createItems = useMemo(
    () => [
      ...(hasLocal ? [{ value: LOCAL_VALUE, label: "本机" }] : []),
      ...remoteNodes.map((n) => ({
        value: n.id,
        label: `${n.name}${n.access === "shared" ? " · 共享" : ""} · ${statusLabel(n.status)}`,
      })),
    ],
    [hasLocal, remoteNodes],
  );

  const migrateItems = useMemo(() => {
    const current = agent?.runtimeNodeId || LOCAL_VALUE;
    return [
      ...(hasLocal ? [{ value: LOCAL_VALUE, label: "本机 (local)" }] : []),
      ...remoteNodes.map((n) => ({
        value: n.id,
        label: `${n.name}${n.access === "shared" ? " · 共享" : ""} · ${statusLabel(n.status)}`,
      })),
    ].filter((i) => i.value !== current);
  }, [agent?.runtimeNodeId, hasLocal, remoteNodes]);

  async function createComputer() {
    setCreating(true);
    try {
      const runtimeNodeId = createNodeId === LOCAL_VALUE ? null : createNodeId;
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        json: { enableComputer: true, restart: false },
      });
      await api(`/api/agents/${id}/start`, {
        method: "POST",
        json: { runtimeNodeId },
      });
      toast.success("已创建电脑");
      setCreateOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function deleteComputer() {
    if (!(await confirm({ title: "删除电脑？", description: "将停止环境并关闭电脑能力。", confirmLabel: "删除电脑" }))) return;
    setDeleting(true);
    try {
      try {
        await api(`/api/agents/${id}/stop`, { method: "POST" });
      } catch {
        /* already stopped */
      }
      await api(`/api/agents/${id}`, {
        method: "PATCH",
        json: { enableComputer: false, restart: true },
      });
      toast.success("已删除电脑");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  async function startWorkspace() {
    setEnvBusy(true);
    try {
      // Keep current binding when restarting
      await api(`/api/agents/${id}/start`, {
        method: "POST",
        json: {},
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setEnvBusy(false);
    }
  }

  async function stopWorkspace() {
    setEnvBusy(true);
    try {
      await api(`/api/agents/${id}/stop`, { method: "POST" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setEnvBusy(false);
    }
  }

  async function runMigrate() {
    if (!migrateTarget) {
      toast.error("请选择目标 Runner");
      return;
    }
    setMigrateBusy(true);
    setMigrateStatus("准备迁移…");
    try {
      // Stop workspace first
      try {
        await api(`/api/agents/${id}/stop`, { method: "POST" });
      } catch {
        /* ignore */
      }

      const targetNodeId =
        migrateTarget === LOCAL_VALUE
          ? nodes.find((n) => n.kind === "local")?.id
          : migrateTarget;
      if (!targetNodeId) throw new Error("找不到目标节点");

      const res = await api<{ migration: { id: string; status: string } }>(
        `/api/agents/${id}/migrations`,
        {
          method: "POST",
          json: { targetNodeId },
        },
      );
      const jobId = res.migration.id;
      setMigrateStatus(`迁移任务 ${jobId.slice(0, 8)}…`);

      // Poll until terminal
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 800));
        const cur = await api<{
          migration: { status: string; progressPct: number; message?: string | null; error?: string | null };
        }>(`/api/migrations/${jobId}`);
        const m = cur.migration;
        setMigrateStatus(
          `${m.status} ${m.progressPct}%${m.message ? ` · ${m.message}` : ""}`,
        );
        if (m.status === "completed") {
          toast.success("迁移完成，正在目标节点启动…");
          // Bind already updated by migration; start on new node
          await api(`/api/agents/${id}/start`, { method: "POST", json: {} });
          setMigrateOpen(false);
          await load();
          return;
        }
        if (m.status === "failed" || m.status === "cancelled") {
          throw new Error(m.error || `迁移失败: ${m.status}`);
        }
      }
      throw new Error("迁移超时，请稍后在 Runners 页查看任务状态");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrateBusy(false);
      setMigrateStatus(null);
    }
  }

  if (!agent) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const hasComputer = needsContainer(agent);
  const showLog =
    progress &&
    (progress.running ||
      progress.events.length > 0 ||
      wsStatus === "starting" ||
      wsStatus === "error");
  const workspaceRunning = wsStatus === "running";

  if (!hasComputer) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="电脑" />
        {agent.lastError ? (
          <Alert variant="destructive">
            <AlertDescription>{agent.lastError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
          <Monitor className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">尚未创建电脑</p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Monitor />
            创建电脑
          </Button>
        </div>

        <CreateComputerDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          createNodeId={createNodeId}
          setCreateNodeId={setCreateNodeId}
          createItems={createItems}
          remoteNodes={remoteNodes}
          creating={creating}
          onConfirm={() => void createComputer()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="电脑"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {workspaceStatusLabel(wsStatus)}
            </span>
            <Button
              size="sm"
              disabled={envBusy || progress?.running}
              onClick={() => void startWorkspace()}
            >
              {envBusy || progress?.running ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
              启动
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={envBusy}
              onClick={() => void stopWorkspace()}
            >
              <Square />
              停止
            </Button>
          </div>
        }
      />

      <SettingsSection title="运行位置">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <HardDrive className="size-4 text-muted-foreground" />
            {currentNode ? (
              <>
                <span className="font-medium">{currentNode.name}</span>
                <Badge variant="outline">{kindLabel(currentNode.kind)}</Badge>
                <Badge variant={statusVariant(currentNode.status)}>
                  {statusLabel(currentNode.status)}
                </Badge>
                {currentNode.endpoint ? (
                  <code className="text-[11px] text-muted-foreground">
                    {currentNode.endpoint}
                  </code>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                {agent.runtimeNodeId ? `节点 ${agent.runtimeNodeId}` : "本机"}
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/runners" />}
            >
              管理 Runners
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={migrateItems.length === 0}
              onClick={() => {
                setMigrateTarget(migrateItems[0]?.value ?? "");
                setMigrateOpen(true);
              }}
            >
              <ArrowRightLeft />
              迁移
            </Button>
          </div>
        </div>
      </SettingsSection>

      {agent.lastError ? (
        <Alert variant="destructive">
          <AlertDescription>{agent.lastError}</AlertDescription>
        </Alert>
      ) : null}

      {showLog ? (
        <SettingsSection title="日志">
          <div className="max-h-56 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
            {(progress?.events ?? []).map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                className={cn("flex gap-2", levelColor(e.level))}
              >
                <span className="shrink-0 opacity-50">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span className="shrink-0 font-semibold">{e.step}</span>
                <span className="min-w-0 break-all">{e.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {progress?.running ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={
          <div className="flex items-center justify-between gap-2">
            <span>桌面</span>
            {agent.desktop?.novncUrl ? (
              <Button
                size="icon-sm"
                variant="ghost"
                nativeButton={false}
                render={
                  <a href={agent.desktop.novncUrl} target="_blank" rel="noreferrer" />
                }
              >
                <ExternalLink />
              </Button>
            ) : null}
          </div>
        }
      >
        {agent.desktop?.novncUrl && workspaceRunning ? (
          <iframe
            title="desktop"
            src={agent.desktop.novncUrl}
            className="min-h-[280px] w-full rounded-md border bg-black"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
            {workspaceRunning ? "桌面准备中…" : "启动后可用"}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="文件">
        <AgentFileManager agentId={id} canWrite />
      </SettingsSection>

      <div className="border-t pt-4">
        <Button
          size="sm"
          variant="destructive"
          disabled={deleting}
          onClick={() => void deleteComputer()}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          删除电脑
        </Button>
      </div>

      <Dialog open={migrateOpen} onOpenChange={setMigrateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>迁移电脑工作区</DialogTitle>
            <DialogDescription>迁移工作区到目标 Runner</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>目标 Runner</Label>
              <Select
                value={migrateTarget}
                onValueChange={(v) => {
                  if (v) setMigrateTarget(v);
                }}
                items={migrateItems}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {migrateItems.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {migrateStatus ? (
              <p className="text-xs text-muted-foreground font-mono">{migrateStatus}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={migrateBusy}
              onClick={() => setMigrateOpen(false)}
            >
              取消
            </Button>
            <Button disabled={migrateBusy} onClick={() => void runMigrate()}>
              {migrateBusy ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />}
              开始迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateComputerDialog({
  open,
  onOpenChange,
  createNodeId,
  setCreateNodeId,
  createItems,
  remoteNodes,
  creating,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  createNodeId: string;
  setCreateNodeId: (v: string) => void;
  createItems: Array<{ value: string; label: string }>;
  remoteNodes: RuntimeNode[];
  creating: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建电脑</DialogTitle>
          <DialogDescription>选择运行节点</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>运行位置</Label>
            <Select
              value={createNodeId}
              onValueChange={(v) => {
                if (v) setCreateNodeId(v);
              }}
              items={createItems}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {createItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {remoteNodes.length === 0 && createItems.some((i) => i.value === LOCAL_VALUE) ? (
            <p className="text-[11px] text-muted-foreground">
              尚未注册远程 Runner。可先在本机创建，或前往{" "}
              <Link href="/dashboard/runners" className="underline">
                Runners
              </Link>{" "}
              注册设备。
            </p>
          ) : null}
          {!createItems.length ? (
            <p className="text-[11px] text-warning-foreground">
              当前没有可用运行节点。请联系管理员授权本机 Runner，或等待共享 Runner 上线。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={
              creating ||
              !createItems.length ||
              (createNodeId !== LOCAL_VALUE &&
                remoteNodes.find((n) => n.id === createNodeId)?.status !== "online")
            }
            onClick={onConfirm}
          >
            {creating ? <Loader2 className="animate-spin" /> : <Monitor />}
            创建并启动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
