"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { listRuntimeNodes, type RuntimeNode } from "@/lib/runners";
import { createWorkspaceDisk, deleteWorkspaceDisk, diskDeletionDescription, diskNodeUnavailableReason, diskStateText, diskUnavailableReason, diskUsageIsStale, listWorkspaceDisks, refreshWorkspaceDisk, renameWorkspaceDisk, type WorkspaceDisk, type WorkspaceDisks } from "@/lib/workspace-disks";

function usage(bytes: number | null) {
  if (bytes === null) return "尚未采样";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}

export default function SpaceDisksPage() {
  const { id: spaceId } = useParams<{ id: string }>();
  const [data, setData] = useState<WorkspaceDisks | null>(null);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const lock = useRef(false);
  const requests = useRef(new Map<string, string>());
  const { confirm } = useConfirmDialog();
  const load = useCallback(async () => {
    const [next, available] = await Promise.all([listWorkspaceDisks(spaceId), listRuntimeNodes()]);
    setData(next); setNodes(available);
  }, [spaceId]);
  useEffect(() => {
    let alive = true;
    setData(null); setError(""); setCreating(false); setEditing(null); requests.current.clear();
    void Promise.all([listWorkspaceDisks(spaceId), listRuntimeNodes()]).then(([next, available]) => {
      if (!alive) return;
      setData(next); setNodes(available);
      const usable = available.filter(node => !diskNodeUnavailableReason(node));
      setNodeId(usable.length === 1 ? usable[0].id : "");
    }).catch(err => { if (alive) setError(err instanceof Error ? err.message : "加载数据盘失败"); });
    return () => { alive = false; };
  }, [spaceId]);
  const pending = data?.cleanups.some(job => job.pending) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => { void load().catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [load, pending]);
  async function perform(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "操作失败"); await load().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  }
  async function remove(disk: WorkspaceDisk) {
    if (!await confirm({ title: `${disk.nodeRemovedAt ? "移除" : "删除"}“${disk.name}”？`, description: disk.nodeRemovedAt ? "原节点已删除。只移除平台中的数据盘记录，不会同步或删除远端文件。" : diskDeletionDescription, confirmLabel: disk.nodeRemovedAt ? "移除盘记录" : "永久删除数据盘" })) return;
    const requestId = requests.current.get(disk.id) ?? crypto.randomUUID();
    requests.current.set(disk.id, requestId);
    await perform(() => deleteWorkspaceDisk(spaceId, disk.id, requestId));
  }
  const eligible = nodes.filter(node => !diskNodeUnavailableReason(node));
  return <section className="space-y-6">
    <SettingsHeader title="数据盘" description="文件保存在盘中。删除工作区后，释放完成的数据盘可以用于重建。" actions={<><Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(load)}>刷新</Button><Button size="sm" disabled={busy} onClick={() => setCreating(value => !value)}>新建数据盘</Button></>} />
    {creating ? <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void perform(async () => { await createWorkspaceDisk(spaceId, name.trim(), nodeId); setCreating(false); setName(""); }); }}>
      <div className="min-w-48 flex-1 space-y-2"><Label htmlFor="disk-name">名称</Label><Input id="disk-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required /></div>
      <div className="min-w-48 flex-1 space-y-2"><Label htmlFor="disk-node">存放节点</Label><select id="disk-node" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nodeId} onChange={event => setNodeId(event.target.value)} required><option value="">选择节点</option>{eligible.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></div>
      <Button size="sm" type="submit" disabled={busy || !name.trim() || !nodeId}>创建</Button>
      {!eligible.length ? <p className="w-full text-sm text-muted-foreground">需要在线且支持数据盘的节点。请在<Link className="mx-1 underline" href="/dashboard/runners">节点设置</Link>更新或连接节点。</p> : null}
    </form> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {!data ? <p className="text-sm text-muted-foreground">{error ? "点击刷新重试。" : "正在加载…"}</p> : data.disks.length === 0 ? <p className="text-sm text-muted-foreground">还没有数据盘。新建一个盘，然后到工作区页面选择它。</p> : <ul className="divide-y">
      {data.disks.map(disk => {
        const node = nodes.find(item => item.id === disk.nodeId);
        const online = node?.status === "online";
        const reusable = !diskUnavailableReason(disk, node);
        return <li key={disk.id} className="space-y-2 py-4 first:pt-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              {editing === disk.id ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void perform(async () => { await renameWorkspaceDisk(spaceId, disk.id, draft.trim()); setEditing(null); }); }}><Input aria-label="数据盘名称" className="max-w-sm" value={draft} onChange={event => setDraft(event.target.value)} maxLength={100} required /><Button size="sm" disabled={busy || !draft.trim()}>保存</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button></form> : <p className="break-words text-sm font-medium">{disk.name}</p>}
              <p className="text-xs text-muted-foreground">{disk.nodeRemovedAt ? "原节点已删除，已停止同步" : <>{node?.name ?? "原节点不可用"}，{diskStateText[disk.state] ?? "状态待确认"}{!online ? "，节点离线" : ""}</>}</p>
              <p className="text-xs text-muted-foreground">{usage(disk.usedBytes)}{disk.sampledAt ? `，采样于 ${new Date(disk.sampledAt).toLocaleString()}` : ""}{diskUsageIsStale(disk, online) && disk.sampledAt ? "（旧数据）" : ""}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {reusable ? <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/dashboard/spaces/${encodeURIComponent(spaceId)}/settings/computer?disk=${encodeURIComponent(disk.id)}`} />}>用于重建</Button> : null}
              <Button size="sm" variant="ghost" disabled={busy || Boolean(disk.nodeRemovedAt) || !online || !["pending", "available", "attached"].includes(disk.state)} onClick={() => void perform(() => refreshWorkspaceDisk(spaceId, disk.id))}>{disk.state === "pending" ? "重试创建" : "刷新用量"}</Button>
              <Button size="sm" variant="ghost" disabled={busy || disk.state === "delete_pending"} onClick={() => { setEditing(disk.id); setDraft(disk.name); }}>改名</Button>
              <Button size="sm" variant="ghost" disabled={busy || !disk.nodeRemovedAt && (disk.state !== "available" || Boolean(disk.attachedInstanceId))} onClick={() => void remove(disk)}>{disk.nodeRemovedAt ? "移除记录" : "删除"}</Button>
            </div>
          </div>
          {!disk.nodeRemovedAt && (disk.state === "release_pending" || disk.state === "delete_pending") ? <p role="status" className="text-xs text-muted-foreground">等待原节点确认旧工作区已停止并释放文件。完成前不能重新使用此盘。</p> : null}
          {disk.lastError ? <p className="break-words text-xs text-destructive">{disk.lastError}</p> : null}
          {data.cleanups.filter(job => job.diskId === disk.id).map(job => <p key={job.id} role="status" className="break-words text-xs text-muted-foreground">{job.deleteDisk ? "盘删除待完成" : "旧工作区清理待完成"}{job.lastError ? `：${job.lastError}` : "，后台自动重试。"}</p>)}
        </li>;
      })}
    </ul>}
  </section>;
}
