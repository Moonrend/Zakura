"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createWorkspaceDisk, diskDeletionDescription, diskNodeUnavailableReason, diskStateText, diskUnavailableReason, listWorkspaceDisks, type WorkspaceDisk, type WorkspaceInstance, type WorkspaceCleanup } from "@/lib/workspace-disks";
import { api } from "@/lib/api";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { isRunnerHostInfo, listRuntimeNodes, workspaceNodeUnavailableReason, type RuntimeNode } from "@/lib/runners";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Disclosure } from "@/components/ui/disclosure";
import { PageLoading } from "@/components/ui/progress-linear";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NodeStatusDot } from "@/components/node-status-dot";
import { ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsHeader } from "@/components/settings-shell";
import { WorkspaceDesktop } from "@/components/workspace-desktop";
import { FilePanel } from "@/components/chat/file-panel";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";

const WorkspaceTerminalDialog = dynamic(() => import("@/components/workspace-terminal-dialog").then(module => module.WorkspaceTerminalDialog), { ssr: false });
type ServerState = {
  computer: { id: string };
  workspaceInstance?: WorkspaceInstance | null;
  workspaceDisk?: WorkspaceDisk | null;
  workspaceCleanups?: WorkspaceCleanup[];
  space: { runtimeNodeId: string | null; workspaceKind: string; enableComputer: boolean; lastError: string | null; workspaceGeneration?: number };
  /** 实时状态：由服务端在请求时询问节点得到，不读取数据库缓存 */
  // 旧版服务端没有该字段，前端须能容忍缺失
  workspace?: { state: "none" | "running" | "stopped" | "offline" | "unknown"; operation: string | null; error: string | null };
};
type Migration = { id: string; status: string; phase?: string | null; message?: string | null; error?: string | null; progressPct?: number };
const statusText: Record<string, string> = { none: "尚未创建", running: "运行中", stopped: "已停止", offline: "节点离线", unknown: "无法确认状态" };
const operationText: Record<string, string> = { starting: "正在启动", stopping: "正在停止", configuring: "正在配置", migrating: "正在迁移", deleting: "正在删除" };
const phaseText: Record<string, string> = { queued: "准备迁移", preflight: "检查目标节点", quiescing: "暂停任务", stopping: "停止工作区", exporting: "读取文件", copying: "迁移文件", importing: "迁移文件", verifying: "校验文件", switching: "切换节点", restarting: "启动工作区", restoring: "恢复运行", completed: "迁移完成", failed: "迁移失败" };
// 默认选空闲磁盘最多的可用设备，用户无需手动挑选
function preferredNode(nodes: RuntimeNode[]) {
  const free = (node: RuntimeNode) => (isRunnerHostInfo(node.hostInfo) ? (node.hostInfo as { disk?: { freeBytes?: number } }).disk?.freeBytes : undefined) ?? 0;
  return nodes.filter(node => !diskNodeUnavailableReason(node)).sort((a, b) => free(b) - free(a))[0];
}
const activeMigration = (migration: Migration | null) => !!migration && !["completed", "succeeded", "failed", "cancelled"].includes(migration.status);

export function ServerComputerControls({ spaceId, onChanged }: { spaceId: string; onChanged?: () => Promise<void> }) {
  const base = `/api/spaces/${encodeURIComponent(spaceId)}`;
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ServerState | null>(null);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [disks, setDisks] = useState<WorkspaceDisk[]>([]);
  const search = useSearchParams();
  const [diskId, setDiskId] = useState(search.get("disk") ?? "new");
  const [deletion, setDeletion] = useState<{ instanceId: string; requestId: string } | null>(null);
  const [deleteDisk, setDeleteDisk] = useState(false);
  const [target, setTarget] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [options, setOptions] = useState(false);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [pane, setPane] = useState<"desktop" | "files">("desktop");
  const [terminal, setTerminal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { confirm } = useConfirmDialog();
  const workspace = useMemo(() => ({ spaceId }), [spaceId]);
  const stateNodeRef = useRef<string | null>(null);
  stateNodeRef.current = state?.space.runtimeNodeId ?? null;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, storage] = await Promise.all([api<ServerState>(`${base}/computer`, { cacheTtlMs: false }), listWorkspaceDisks()]);
      setState(next); setDisks(storage.disks);
      return next;
    } finally { setLoading(false); }
  }, [base, spaceId]);
  useEffect(() => {
    let alive = true;
    setState(null); setMigration(null); setError("");
    void Promise.allSettled([api<ServerState>(`${base}/computer`, { cacheTtlMs: false }), listRuntimeNodes(), api<{ migrations: Migration[] }>(`${base}/migrations`, { cacheTtlMs: false }), listWorkspaceDisks()]).then(([next, available, jobs, storage]) => {
      if (!alive) return;
      if (next.status === "fulfilled") setState(next.value);
      if (available.status === "fulfilled") {
        setNodes(available.value);
        setNodeId(preferredNode(available.value)?.id ?? "");
      }
      if (jobs.status === "fulfilled") setMigration(jobs.value.migrations[0] ?? null);
      if (storage.status === "fulfilled") setDisks(storage.value.disks);
      const failure = [next, available, jobs, storage].find(result => result.status === "rejected");
      if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "加载工作区失败");
    });
    return () => { alive = false; };
  }, [base, reload, spaceId]);
  useEffect(() => {
    if (!state?.workspaceCleanups?.some(job => job.pending) && !activeMigration(migration)) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void Promise.all([api<ServerState>(`${base}/computer`, { cacheTtlMs: false }), migration && activeMigration(migration) ? api<{ migration: Migration }>(`/api/migrations/${encodeURIComponent(migration.id)}`, { cacheTtlMs: false }) : Promise.resolve(null)]).then(([next, job]) => {
        if (!alive) return;
        setState(next);
        if (job) setMigration(job.migration);
      }).catch(err => { if (alive) setError(err instanceof Error ? err.message : "刷新失败"); });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [base, state?.workspaceCleanups, migration]);
  // 工作区状态变化由服务端推送，收到后重新向节点确认实时状态。
  useEffect(() => {
    let alive = true;
    const refresh = () => { void api<ServerState>(`${base}/computer`, { cacheTtlMs: false }).then(next => { if (alive) setState(next); }).catch(() => {}); };
    const unsubscribe = subscribePlatformEvents(event => {
      if (event.type === "workspace_changed" && event.spaceId === spaceId) refresh();
      if (event.type === "runner_node" && event.nodeId === stateNodeRef.current) refresh();
    }, refresh);
    return () => { alive = false; unsubscribe(); };
  }, [base, spaceId]);

  const initialized = Boolean(state?.space.runtimeNodeId);
  const running = state?.workspace?.state === "running";
  const operation = state?.workspace?.operation ?? null;
  const pending = Boolean(operation) || activeMigration(migration);
  const online = nodes.filter(node => !diskNodeUnavailableReason(node));
  const targets = nodes.filter(node => !workspaceNodeUnavailableReason(node) && node.id !== state?.space.runtimeNodeId);
  const unavailable = nodes.filter(node => diskNodeUnavailableReason(node));
  const selectedDisk = disks.find(disk => disk.id === diskId);
  const canCreate = diskId === "new" ? online.some(node => node.id === nodeId) : Boolean(selectedDisk && !diskUnavailableReason(selectedDisk, nodes.find(node => node.id === selectedDisk.nodeId)));
  const currentNode = nodes.find(node => node.id === state?.space.runtimeNodeId);
  const nodeIssue = initialized && currentNode ? workspaceNodeUnavailableReason(currentNode) : null;
  async function action(kind: "create" | "start" | "stop") {
    if (lock.current || !state || pending || loading) return;
    if (kind === "stop" && !await confirm({ title: "停止工作区？", description: "使用工作区的任务会暂时停止，持久文件保留。", confirmLabel: "停止" })) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (kind === "create") {
        let selected = selectedDisk;
        if (diskId === "new") {
          selected = (await createWorkspaceDisk("工作区数据", nodeId)).disk;
          setDiskId(selected.id);
        }
        if (!selected || selected.state !== "available") throw new Error("数据盘尚未确认创建完成，请到数据盘页面刷新后重试。");
        await api(`${base}/computer/config`, { method: "PUT", json: { diskId: selected.id, workspaceKind: "container", enableComputer: true } });
      }
      await api(`${base}/computer/${kind === "create" ? "start" : kind}`, { method: "POST", json: {} });
      await load(); await onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "操作失败"); await load().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  }
  async function retire() {
    if (!deletion || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      await api(`${base}/computer`, { method: "DELETE", json: { expectedInstanceId: deletion.instanceId, requestId: deletion.requestId, deleteDisk } });
      setDeletion(null); setTerminal(false); setDiskId("new");
      await load(); await onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "删除请求失败"); await load().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  }
  async function migrate() {
    if (lock.current || !target || !await confirm({ title: "迁移工作区？", description: "迁移期间暂停任务，完成后使用目标节点。源文件会保留。", confirmLabel: "迁移" })) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ migration: Migration }>(`${base}/migrations`, { method: "POST", json: { targetNodeId: target } });
      setMigration(result.migration); setMigrating(false); toast.success("迁移已开始");
    } catch (err) { setError(err instanceof Error ? err.message : "迁移失败"); }
    finally { lock.current = false; setBusy(false); }
  }
  const statusLine = operation ? operationText[operation] ?? "正在处理" : activeMigration(migration) ? "正在迁移" : (state?.workspace ? statusText[state.workspace.state] : undefined) ?? "无法确认状态";
  const alert = error || state?.workspace?.error || state?.space.lastError;
  const reusable = disks.filter(disk => !diskUnavailableReason(disk, nodes.find(node => node.id === disk.nodeId)));
  return <section className="space-y-4">
    <SettingsHeader title="工作区" description={initialized ? undefined : "工作区是这个空间专属的云端电脑，Agent 在这里读写文件、运行命令。"} />
    <Dialog open={Boolean(deletion)} onOpenChange={open => { if (!open && !busy) setDeletion(null); }}><DialogContent><DialogHeader><DialogTitle>删除工作区？</DialogTitle><DialogDescription>立即停止平台访问。设备离线时，远端容器可能仍在运行，后台会在设备上线后清理。</DialogDescription></DialogHeader>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={deleteDisk} disabled={busy} onChange={event => setDeleteDisk(event.target.checked)} /><span>同时永久删除数据盘</span></label>
      <p className="text-sm text-muted-foreground">{deleteDisk ? diskDeletionDescription : "保留盘中的文件，之后可以用这块盘重新创建工作区。"}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeletion(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void retire()}>{busy ? "正在提交…" : deleteDisk ? "删除工作区和数据盘" : "删除工作区"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={migrating} onOpenChange={open => { if (!busy) setMigrating(open); }}><DialogContent><DialogHeader><DialogTitle>迁移到其他设备</DialogTitle><DialogDescription>迁移期间暂停任务，完成后使用目标设备，源文件会保留。</DialogDescription></DialogHeader>
      {targets.length ? <select aria-label="目标设备" value={target} onChange={event => setTarget(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="">选择目标设备</option>{targets.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select> : <p className="text-sm text-muted-foreground">没有其他可用设备。</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setMigrating(false)}>取消</Button><Button disabled={busy || !target} onClick={() => void migrate()}>迁移</Button></DialogFooter>
    </DialogContent></Dialog>
    {state ? <>
      {initialized ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card px-4 py-3 shadow-surface-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm">{pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <NodeStatusDot status={running ? "online" : "offline"} />}{statusLine}</p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{currentNode ? <Link className="hover:underline" href={`/dashboard/runners/${encodeURIComponent(currentNode.id)}`}>{currentNode.name}</Link> : "当前设备不可用"}{state.workspaceDisk ? ` · ${state.workspaceDisk.name}` : ""}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={running ? "outline" : "default"} disabled={busy || pending || loading} onClick={() => void action(running ? "stop" : "start")}>{busy ? <Loader2 className="animate-spin" /> : null}{running ? "停止" : state.space.lastError ? "重试" : "启动"}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="工作区操作" />}><MoreHorizontal /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              {!state.workspaceInstance ? <DropdownMenuItem disabled={busy || pending || loading} onClick={() => { setTarget(""); setMigrating(true); }}>迁移到其他设备</DropdownMenuItem> : null}
              <DropdownMenuItem render={<Link href="/dashboard/disks" />}>管理数据盘</DropdownMenuItem>
              {state.workspaceInstance ? <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={busy || loading || activeMigration(migration)} onClick={() => { setDeleteDisk(false); setError(""); setDeletion({ instanceId: state.workspaceInstance!.instanceId, requestId: crypto.randomUUID() }); }}>删除工作区</DropdownMenuItem></> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div> : <div className="space-y-3 rounded-lg bg-card p-4 shadow-surface-2">
        {online.length ? <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">{diskId === "new" ? `将在「${online.find(node => node.id === nodeId)?.name ?? "—"}」上创建，并新建一块数据盘。` : `将使用数据盘「${selectedDisk?.name ?? "—"}」中已有的文件。`}</p>
            <Button size="sm" disabled={busy || !canCreate || pending} onClick={() => void action("create")}>{busy ? <Loader2 className="animate-spin" /> : null}{busy ? "正在创建…" : "创建工作区"}</Button>
          </div>
          {online.length > 1 || reusable.length ? <>
            <button type="button" className="press flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={options} onClick={() => setOptions(value => !value)}><ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out-soft", options && "rotate-90")} />选项</button>
            <Disclosure open={options} innerClassName="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="workspace-disk">数据盘</Label><select id="workspace-disk" value={diskId} onChange={event => setDiskId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="new">新建数据盘</option>{reusable.map(disk => <option key={disk.id} value={disk.id}>{disk.name}（保留文件）</option>)}</select></div>
              {diskId === "new" && online.length > 1 ? <div className="space-y-1.5"><Label htmlFor="workspace-node">设备</Label><select id="workspace-node" value={nodeId} onChange={event => setNodeId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">{online.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></div> : null}
            </Disclosure>
          </> : null}
        </> : <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1"><p className="text-sm">没有可用设备</p>{unavailable.length ? <ul className="space-y-0.5 text-xs text-muted-foreground">{unavailable.map(node => <li key={node.id} className="break-words">{node.name}：{diskNodeUnavailableReason(node)}</li>)}</ul> : <p className="text-xs text-muted-foreground">先接入一台安装了 Docker 的电脑或服务器。</p>}</div>
          <Button size="sm" nativeButton={false} render={<Link href="/dashboard/runners" />}>{unavailable.length ? "查看设备" : "添加设备"}</Button>
        </div>}
      </div>}
      {nodeIssue ? <p role="status" className="break-words text-xs text-muted-foreground">{nodeIssue}</p> : null}
      {migration && (activeMigration(migration) || migration.status === "failed") ? <p role="status" className="break-words text-xs text-muted-foreground">{phaseText[migration.phase ?? ""] ?? (activeMigration(migration) ? "迁移中" : "迁移失败")}{migration.message ? ` · ${migration.message}` : ""}{migration.error ? ` · ${migration.error}` : ""}</p> : null}
      {alert ? <p role="alert" className="break-words text-xs text-destructive">{alert}</p> : null}
      {state.workspaceCleanups?.map(job => <p key={job.id} role="status" className="break-words text-xs text-muted-foreground">旧工作区等待清理{job.deleteDisk ? "，随后删除数据盘" : ""}，设备上线后自动完成。{job.lastError ? ` ${job.lastError}` : ""}</p>)}
      {initialized ? <>
        <div className="flex items-center gap-1"><Button size="sm" variant={pane === "desktop" ? "secondary" : "ghost"} onClick={() => setPane("desktop")}>桌面</Button><Button size="sm" variant={pane === "files" ? "secondary" : "ghost"} onClick={() => setPane("files")}>文件</Button><Button size="sm" variant="ghost" disabled={!running || pending} onClick={() => setTerminal(true)}>终端</Button></div>
        {pane === "desktop" ? <WorkspaceDesktop spaceId={spaceId} active={running && !pending && state.space.enableComputer} /> : <div className="h-[65vh] min-h-96"><FilePanel agentId={workspace} fsEnabled={!pending} layout="page" /></div>}
        <WorkspaceTerminalDialog open={terminal} onOpenChange={setTerminal} ticketPath={`${base}/computers/${encodeURIComponent(state.computer.id)}/terminal-ticket`} />
      </> : null}
    </> : error ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>重试</Button></div> : <PageLoading />}
  </section>;
}
