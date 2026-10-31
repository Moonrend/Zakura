"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ChevronRight, Loader2, MoreHorizontal, Plus, Square } from "lucide-react";
import {
  allocateNodeContainer,
  deleteNodeDescription,
  deleteRuntimeNode,
  fetchImageUpdates,
  fetchRunnerDetail,
  fetchRunnerInstall,
  formatBytes,
  isRunnerHostInfo,
  listNodeContainers,
  patchRuntimeNode,
  pickInstallPackage,
  resolveImageUpdateKind,
  runnerUpdateProgressText,
  statusLabel,
  stopContainer,
  upgradeNodeImage,
  type ImageUpdateEntry,
  type ManagedContainerRow,
  type RunnerHostInfo,
  type RunnerInstallPackage,
  type RuntimeNode,
} from "@/lib/runners";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { RunnerInstallPanel } from "@/components/runner-install-panel";
import { NodeStatusDot } from "@/components/node-status-dot";
import { SettingsField, SettingsHeader, SettingsSection, TableActions } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

function hostInfoOf(node: RuntimeNode): RunnerHostInfo {
  return isRunnerHostInfo(node.hostInfo) ? (node.hostInfo as RunnerHostInfo) : {};
}

const actionable = (entry: ImageUpdateEntry) => entry.updateAvailable || entry.runningStale;

export default function RunnerDetailPage() {
  const { confirm } = useConfirmDialog();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [node, setNode] = useState<RuntimeNode | null>(null);
  const [containers, setContainers] = useState<ManagedContainerRow[]>([]);
  const [install, setInstall] = useState<RunnerInstallPackage | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<ImageUpdateEntry[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [allocOpen, setAllocOpen] = useState(false);

  const manageable = (n: RuntimeNode | null) => Boolean(n && n.kind !== "local" && n.access !== "shared");

  // 安装命令：平台组网可用时直接给组网版本（公网 / NAT 都可用），不让用户选。
  const loadInstall = useCallback(async () => {
    setInstallError(null);
    try {
      const bundle = await fetchRunnerInstall(id);
      setInstall(pickInstallPackage(bundle, true));
    } catch (err) {
      setInstall(null);
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const checkUpdates = useCallback(async (pull = false) => {
    setChecking(true);
    try {
      const res = await fetchImageUpdates(id, { runnerOnly: !pull, allowPullFallback: pull });
      setUpdates(res.images ?? []);
    } catch {
      setUpdates(null);
    } finally {
      setChecking(false);
    }
  }, [id]);

  const load = useCallback(async (initial = false) => {
    try {
      const res = await fetchRunnerDetail(id);
      setNode(res.node);
      setContainers(res.containers);
      if (initial && manageable(res.node)) {
        void loadInstall();
        if (res.node.status === "online") void checkUpdates();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id, loadInstall, checkUpdates]);

  useEffect(() => {
    void load(true);
    let last = 0;
    const reload = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void load();
    };
    return subscribePlatformEvents((ev) => {
      if (ev.type === "runner_node" && ev.nodeId === id) reload();
    }, reload);
  }, [id, load]);

  async function rename() {
    if (!node || !draft.trim()) return;
    try {
      setNode(await patchRuntimeNode(node.id, { name: draft.trim() }));
      setRenaming(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    if (!node || !(await confirm({ title: `删除「${node.name}」？`, description: deleteNodeDescription, confirmLabel: "删除" }))) return;
    try {
      await deleteRuntimeNode(node.id);
      toast.success("已删除");
      router.push("/dashboard/runners");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // 一个按钮完成所有更新：先刷新工作区容器，最后再重启代理，避免代理重连打断容器重建。
  async function updateAll() {
    if (!node || !updates) return;
    const pending = updates.filter(actionable).sort((a, b) => Number(resolveImageUpdateKind(a) === "runner") - Number(resolveImageUpdateKind(b) === "runner"));
    if (!pending.length) return;
    setUpdating(true);
    setProgress("");
    try {
      for (const entry of pending) {
        await upgradeNodeImage(node.id, entry, (u) => setProgress(runnerUpdateProgressText(u)));
      }
      setProgress("");
      toast.success("更新完成");
      void load();
      void checkUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProgress(`更新失败：${msg}`);
      toast.error(msg);
    } finally {
      setUpdating(false);
    }
  }

  if (!node) return <PageLoading />;

  const host = hostInfoOf(node);
  const interfaces = host.interfaces ?? [];
  const isLocal = node.kind === "local";
  const canManage = manageable(node);
  const online = node.status === "online";
  const neverConnected = !isLocal && !node.lastSeenAt;
  const pendingUpdates = updates?.filter(actionable) ?? [];
  const probeFailed = updates?.some((entry) => entry.error) ?? false;

  const installBlock = installError ? (
    <p className="text-xs text-destructive whitespace-pre-wrap">{installError}</p>
  ) : install ? (
    <RunnerInstallPanel install={install} />
  ) : (
    <PageLoading />
  );

  return (
    <div className="space-y-5">
      <SettingsHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Button size="icon" variant="ghost" className="size-8" title="返回" nativeButton={false} render={<Link href="/dashboard/runners" />}>
              <ArrowLeft />
            </Button>
            {node.name}
          </span>
        }
        actions={
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="设备操作" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-32">
                <DropdownMenuItem onClick={() => { setDraft(node.name); setRenaming(true); }}>重命名</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void remove()}>删除设备</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <NodeStatusDot status={node.status} />
        <span>{neverConnected ? "等待安装" : statusLabel(node.status)}</span>
        {!online && node.lastSeenAt ? <span className="text-muted-foreground">· 最近在线 {formatRelative(node.lastSeenAt)}</span> : null}
        {node.access === "shared" || node.isShared ? <Badge variant="secondary">共享</Badge> : null}
        {node.needsReinstall ? <Badge variant="destructive">需重装</Badge> : null}
      </div>

      {canManage && (neverConnected || node.needsReinstall) ? (
        <SettingsSection title="安装" description="在设备上以管理员身份运行下面的命令，设备上线后这里会自动更新。需要已安装 Docker。">
          {installBlock}
        </SettingsSection>
      ) : null}

      {!neverConnected ? (
        <SettingsSection>
          <div className="divide-y divide-border/60">
            <SettingsField label="系统">
              <span className="text-sm text-muted-foreground">{[host.platform, host.arch].filter(Boolean).join(" / ") || "—"}</span>
            </SettingsField>
            <SettingsField label="主机">
              <span className="text-sm text-muted-foreground">{[host.hostname, host.primaryIp].filter(Boolean).join(" · ") || "—"}</span>
            </SettingsField>
            <SettingsField label="磁盘">
              <span className="text-sm text-muted-foreground tabular-nums">
                {host.disk ? `${formatBytes(host.disk.freeBytes)} 可用 / 共 ${formatBytes(host.disk.totalBytes)}` : "—"}
              </span>
            </SettingsField>
            <SettingsField label="Docker">
              <span className="text-sm text-muted-foreground">{host.dockerVersion || (node.dockerError ? "不可用" : "—")}</span>
            </SettingsField>
            {host.tailscale ? (
              <SettingsField label="组网">
                <span className="text-sm text-muted-foreground">{host.tailscale.connected ? host.tailscale.ip || "已连接" : "未连接"}</span>
              </SettingsField>
            ) : null}
          </div>
          {node.dockerError ? <p className="text-xs text-destructive">{node.dockerError}</p> : null}
        </SettingsSection>
      ) : null}

      {canManage && !neverConnected ? (
        <SettingsSection
          title="版本"
          description={node.agentVersion ? `zakura-agent v${node.agentVersion}` : "代理尚未上报版本"}
          action={
            pendingUpdates.length ? (
              <Button size="sm" disabled={updating || !online} onClick={() => void updateAll()}>
                {updating ? <Loader2 className="animate-spin" /> : null}
                更新
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={checking || !online} onClick={() => void checkUpdates(true)}>
                {checking ? <Loader2 className="animate-spin" /> : null}
                检查更新
              </Button>
            )
          }
        >
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {progress
              ? progress
              : !online
                ? "设备离线，上线后可检查更新。"
                : checking
                  ? "正在检查…"
                  : pendingUpdates.length
                    ? `有 ${pendingUpdates.length} 项更新。更新会短暂重启代理并重建本设备上的 zakura 容器，不影响其它 Docker 应用。`
                    : probeFailed
                      ? "部分组件无法确认版本，请稍后重新检查。"
                      : updates
                        ? "已是最新版本。"
                        : "尚未检查。"}
          </p>
        </SettingsSection>
      ) : null}

      <div>
        <button
          type="button"
          className="press flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          <ChevronRight className={cn("size-4 transition-transform duration-200 ease-out-soft", advanced && "rotate-90")} />
          高级
        </button>
        <Disclosure open={advanced} innerClassName="space-y-5 pt-3">
          <SettingsSection
            title="容器"
            description={isLocal ? undefined : "由平台在此设备上创建的容器。"}
            action={
              <span className="inline-flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void listNodeContainers(id).then(setContainers).catch((err) => toast.error(String(err)))}>
                  刷新
                </Button>
                {isLocal ? (
                  <Button size="sm" variant="outline" onClick={() => setAllocOpen(true)}>
                    <Plus />
                    分配
                  </Button>
                ) : null}
              </span>
            }
          >
            {containers.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>镜像</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {containers.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.purpose}</div>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground" title={r.image}>{r.image}</TableCell>
                      <TableCell className="text-xs">{r.status}</TableCell>
                      <TableCell>
                        <TableActions>
                          {r.dockerId && r.status !== "removed" ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="停止并移除"
                              onClick={async () => {
                                if (!(await confirm({ title: `停止并移除「${r.name}」？`, confirmLabel: "停止" }))) return;
                                try {
                                  await stopContainer(r.id, true);
                                  setContainers(await listNodeContainers(id));
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : String(err));
                                }
                              }}
                            >
                              <Square />
                            </Button>
                          ) : null}
                        </TableActions>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">暂无容器</p>
            )}
          </SettingsSection>

          {interfaces.length ? (
            <SettingsSection title="网卡">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>接口</TableHead>
                    <TableHead>IPv4</TableHead>
                    <TableHead className="hidden sm:table-cell">MAC</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...interfaces].sort((a, b) => Number(a.internal) - Number(b.internal)).map((iface) => (
                    <TableRow key={iface.name}>
                      <TableCell className="font-mono text-xs">
                        {iface.name}
                        {iface.internal ? <span className="ml-1.5 text-muted-foreground">内部</span> : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{iface.ipv4?.length ? iface.ipv4.join(", ") : "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{iface.mac || "—"}</TableCell>
                      <TableCell className="text-xs">{iface.operstate || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SettingsSection>
          ) : null}

          <SettingsSection title="标识">
            <div className="divide-y divide-border/60">
              <SettingsField label="设备 ID"><code className="text-xs text-muted-foreground">{node.id}</code></SettingsField>
              <SettingsField label="存储目录"><code className="text-xs text-muted-foreground break-all">{node.storageRoot}</code></SettingsField>
              {host.publicUrl ? <SettingsField label="对外地址"><code className="text-xs text-muted-foreground break-all">{host.publicUrl}</code></SettingsField> : null}
              <SettingsField label="添加时间"><span className="text-xs text-muted-foreground">{formatAbsolute(node.createdAt)}</span></SettingsField>
            </div>
          </SettingsSection>

          {canManage && !neverConnected && !node.needsReinstall ? (
            <SettingsSection title="重新安装" description="设备重装系统或代理损坏时，在设备上重新运行此命令。">
              {installBlock}
            </SettingsSection>
          ) : null}
        </Disclosure>
      </div>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名设备</DialogTitle>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
            <Input aria-label="名称" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={100} autoFocus />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>取消</Button>
              <Button type="submit" disabled={!draft.trim()}>保存</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {isLocal ? <AllocateDialog open={allocOpen} onOpenChange={setAllocOpen} nodeId={node.id} onDone={() => void listNodeContainers(id).then(setContainers)} /> : null}
    </div>
  );
}

function AllocateDialog({ open, onOpenChange, nodeId, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; nodeId: string; onDone: () => void }) {
  const [form, setForm] = useState({ image: "python:3.12-slim", name: "", purpose: "ephemeral", allocatedTo: "" });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>分配容器</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await allocateNodeContainer(nodeId, { image: form.image, name: form.name || undefined, purpose: form.purpose, allocatedTo: form.allocatedTo || undefined });
              onOpenChange(false);
              onDone();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <div className="space-y-1.5"><Label htmlFor="alloc-image">镜像</Label><Input id="alloc-image" required value={form.image} onChange={set("image")} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label htmlFor="alloc-name">名称</Label><Input id="alloc-name" value={form.name} onChange={set("name")} /></div>
            <div className="space-y-1.5"><Label htmlFor="alloc-purpose">用途</Label><Input id="alloc-purpose" value={form.purpose} onChange={set("purpose")} /></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="alloc-to">分配给</Label><Input id="alloc-to" value={form.allocatedTo} onChange={set("allocatedTo")} /></div>
          <DialogFooter><Button type="submit">创建</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
