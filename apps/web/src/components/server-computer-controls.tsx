"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { api } from "@/lib/api";
import { listRuntimeNodes, type RuntimeNode } from "@/lib/runners";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SettingsHeader } from "@/components/settings-shell";
import { WorkspaceDesktop } from "@/components/workspace-desktop";
import { FilePanel } from "@/components/chat/file-panel";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";

const WorkspaceTerminalDialog = dynamic(() => import("@/components/workspace-terminal-dialog").then(module => module.WorkspaceTerminalDialog), { ssr: false });
type ServerState = {
  computer: { id: string };
  workspaceOperation?: { operation: string };
  space: { runtimeNodeId: string | null; workspaceKind: string; enableComputer: boolean; workspaceStatus: string; lastError: string | null };
};
type Migration = { id: string; status: string; phase?: string | null; message?: string | null; error?: string | null; progressPct?: number };
const statusText: Record<string, string> = { ready: "尚未启动", idle: "尚未启动", running: "运行中", starting: "启动中", stopped: "已停止", error: "启动失败" };
const phaseText: Record<string, string> = { queued: "准备迁移", preflight: "检查目标节点", quiescing: "暂停任务", stopping: "停止工作区", exporting: "读取文件", copying: "迁移文件", importing: "迁移文件", verifying: "校验文件", switching: "切换节点", restarting: "启动工作区", restoring: "恢复运行", completed: "迁移完成", failed: "迁移失败" };
const activeMigration = (migration: Migration | null) => !!migration && !["completed", "succeeded", "failed", "cancelled"].includes(migration.status);

export function ServerComputerControls({ spaceId, onChanged }: { spaceId: string; onChanged?: () => Promise<void> }) {
  const base = `/api/spaces/${encodeURIComponent(spaceId)}`;
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ServerState | null>(null);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [target, setTarget] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [pane, setPane] = useState<"desktop" | "files">("desktop");
  const [terminal, setTerminal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { confirm } = useConfirmDialog();
  const workspace = useMemo(() => ({ spaceId }), [spaceId]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<ServerState>(`${base}/computer`, { cacheTtlMs: false });
      setState(next);
      return next;
    } finally { setLoading(false); }
  }, [base]);
  useEffect(() => {
    let alive = true;
    setState(null); setMigration(null); setError("");
    void Promise.allSettled([api<ServerState>(`${base}/computer`, { cacheTtlMs: false }), listRuntimeNodes(), api<{ migrations: Migration[] }>(`${base}/migrations`, { cacheTtlMs: false })]).then(([next, available, jobs]) => {
      if (!alive) return;
      if (next.status === "fulfilled") setState(next.value);
      if (available.status === "fulfilled") {
        setNodes(available.value);
        const online = available.value.filter(node => node.status === "online");
        setNodeId(online.length === 1 ? online[0].id : "");
      }
      if (jobs.status === "fulfilled") setMigration(jobs.value.migrations[0] ?? null);
      const failure = [next, available, jobs].find(result => result.status === "rejected");
      if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "加载工作区失败");
    });
    return () => { alive = false; };
  }, [base, reload]);
  useEffect(() => {
    if (!state?.workspaceOperation && state?.space.workspaceStatus !== "starting" && !activeMigration(migration)) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void Promise.all([api<ServerState>(`${base}/computer`, { cacheTtlMs: false }), migration && activeMigration(migration) ? api<{ migration: Migration }>(`/api/migrations/${encodeURIComponent(migration.id)}`, { cacheTtlMs: false }) : Promise.resolve(null)]).then(([next, job]) => {
        if (!alive) return;
        setState(next);
        if (job) setMigration(job.migration);
      }).catch(err => { if (alive) setError(err instanceof Error ? err.message : "刷新失败"); });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [base, state?.workspaceOperation, state?.space.workspaceStatus, migration]);

  const initialized = Boolean(state?.space.runtimeNodeId);
  const running = state?.space.workspaceStatus === "running";
  const pending = Boolean(state?.workspaceOperation) || activeMigration(migration);
  const online = nodes.filter(node => node.status === "online");
  const targets = online.filter(node => node.id !== state?.space.runtimeNodeId);
  async function action(kind: "create" | "start" | "stop") {
    if (lock.current || !state || pending || loading) return;
    if (kind === "stop" && !await confirm({ title: "停止工作区？", description: "使用工作区的任务会暂时停止，持久文件保留。", confirmLabel: "停止" })) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (kind === "create") await api(`${base}/computer/config`, { method: "PUT", json: { runtimeNodeId: nodeId, workspaceKind: "container", enableComputer: true } });
      await api(`${base}/computer/${kind === "create" ? "start" : kind}`, { method: "POST", json: {} });
      await load(); await onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "操作失败"); await load().catch(() => {}); }
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
  return <section className="space-y-4">
    <SettingsHeader title="工作区" />
    {state ? <>
      <div className="space-y-3 rounded-xl bg-card p-4 shadow-surface-2">
        {initialized ? <>
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="text-sm">{pending ? "正在检查工作区" : statusText[state.space.workspaceStatus] ?? "状态待确认"}</p><p className="mt-1 break-words text-xs text-muted-foreground">{nodes.find(node => node.id === state.space.runtimeNodeId)?.name ?? "当前节点不可用"}</p></div>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void load().catch(err => setError(String(err)))}>刷新</Button><Button size="sm" variant="outline" disabled={busy || pending || loading} onClick={() => void action(running ? "stop" : "start")}>{busy ? "处理中…" : running ? "停止" : state.space.workspaceStatus === "error" ? "重试" : "启动"}</Button><Button size="sm" variant="ghost" disabled={busy || pending || loading} onClick={() => setMigrating(value => !value)}>迁移节点</Button></div>
          </div>
          {migrating ? <div className="space-y-2"><Label htmlFor="workspace-migration">目标节点</Label><select id="workspace-migration" value={target} onChange={event => setTarget(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="">选择目标节点</option>{targets.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select><Button size="sm" disabled={busy || !target} onClick={() => void migrate()}>迁移</Button></div> : null}
        </> : <>
          {online.length > 1 ? <div className="space-y-2"><Label htmlFor="workspace-node">节点</Label><select id="workspace-node" value={nodeId} onChange={event => setNodeId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="">选择节点</option>{online.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></div> : null}
          {!online.length ? <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/dashboard/runners" />}>连接节点</Button> : <Button size="sm" disabled={busy || !nodeId} onClick={() => void action("create")}>{busy ? "正在创建…" : "创建工作区"}</Button>}
        </>}
        {migration ? <p role="status" className="break-words text-xs text-muted-foreground">{phaseText[migration.phase ?? ""] ?? (activeMigration(migration) ? "迁移中" : migration.status === "failed" ? "迁移失败" : "迁移已结束")}{migration.message ? ` · ${migration.message}` : ""}{migration.error ? ` · ${migration.error}` : ""}</p> : null}
        {error || state.space.lastError ? <p role="alert" className="break-words text-xs text-destructive">{error || state.space.lastError}</p> : null}
      </div>
      {initialized ? <>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant={pane === "desktop" ? "secondary" : "ghost"} onClick={() => setPane("desktop")}>桌面</Button><Button size="sm" variant={pane === "files" ? "secondary" : "ghost"} onClick={() => setPane("files")}>文件</Button><Button size="sm" variant="ghost" disabled={!running || pending} onClick={() => setTerminal(true)}>终端</Button></div>
        {pane === "desktop" ? <WorkspaceDesktop spaceId={spaceId} active={running && !pending && state.space.enableComputer} /> : <div className="h-[65vh] min-h-96"><FilePanel agentId={workspace} fsEnabled={!pending} layout="page" /></div>}
        <WorkspaceTerminalDialog open={terminal} onOpenChange={setTerminal} ticketPath={`${base}/computers/${encodeURIComponent(state.computer.id)}/terminal-ticket`} />
      </> : null}
    </> : error ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>重试</Button></div> : <p className="text-sm text-muted-foreground">正在加载…</p>}
  </section>;
}
