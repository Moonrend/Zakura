"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Boxes,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import {
  allocateNodeContainer,
  deleteRuntimeNode,
  fetchRunnerDetail,
  fetchRunnerInstall,
  fetchRunnerVersion,
  fetchImageUpdates,
  formatBytes,
  isRunnerHostInfo,
  kindLabel,
  listNodeContainers,
  patchRuntimeNode,
  pickInstallPackage,
  refreshWorkspaceImage,
  statusLabel,
  statusVariant,
  stopContainer,
  updateRunner,
  type ManagedContainerRow,
  type RunnerHostInfo,
  type RunnerInstallBundle,
  type RunnerInstallPackage,
  type RunnerVersionInfo,
  type ImageUpdateEntry,
  type RuntimeNode,
} from "@/lib/runners";
import { RunnerInstallPanel } from "@/components/runner-install-panel";
import {
  SettingsField,
  SettingsHeader,
  SettingsSection,
  TableActions,
} from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function hostInfoOf(node: RuntimeNode): RunnerHostInfo {
  return isRunnerHostInfo(node.hostInfo) ? (node.hostInfo as RunnerHostInfo) : {};
}

export default function RunnerDetailPage() {
  const { confirm } = useConfirmDialog();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [node, setNode] = useState<RuntimeNode | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installBundle, setInstallBundle] = useState<RunnerInstallBundle | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [wantTailscale, setWantTailscale] = useState(false);
  const [meshAvailable, setMeshAvailable] = useState(false);
  const [containers, setContainers] = useState<ManagedContainerRow[]>([]);
  const [containersBusy, setContainersBusy] = useState(false);
  const [allocOpen, setAllocOpen] = useState(false);
  const [allocForm, setAllocForm] = useState({
    image: "python:3.12-slim",
    name: "",
    purpose: "ephemeral",
    allocatedTo: "",
  });
  const [versionInfo, setVersionInfo] = useState<RunnerVersionInfo | null>(null);
  const [versionBusy, setVersionBusy] = useState(false);
  const [imageUpdates, setImageUpdates] = useState<ImageUpdateEntry[] | null>(null);
  const [imageUpdatesBusy, setImageUpdatesBusy] = useState(false);

  const loadInstall = useCallback(async () => {
    setInstallBusy(true);
    setInstallError(null);
    try {
      const res = await fetchRunnerInstall(id);
      setInstallBundle(res);
      setMeshAvailable(
        Boolean(
          res.meshConnected ||
            res.meshProvider === "headscale-platform" ||
            res.installTailscale,
        ),
      );
    } catch (err) {
      setInstallBundle(null);
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallBusy(false);
    }
  }, [id]);

  const loadContainers = useCallback(async () => {
    setContainersBusy(true);
    try {
      const list = await listNodeContainers(id);
      setContainers(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setContainersBusy(false);
    }
  }, [id]);

  const loadVersion = useCallback(async () => {
    if (!node || node.kind === "local") return;
    if (node.access === "shared") return;
    setVersionBusy(true);
    try {
      const info = await fetchRunnerVersion(id);
      setVersionInfo(info);
    } catch {
      /* offline / unavailable */
    } finally {
      setVersionBusy(false);
    }
  }, [id, node]);

  const loadImageUpdates = useCallback(async () => {
    if (!node || node.kind === "local" || node.access === "shared") return;
    setImageUpdatesBusy(true);
    try {
      const res = await fetchImageUpdates(id);
      setImageUpdates(res.images ?? []);
    } catch {
      setImageUpdates(null);
    } finally {
      setImageUpdatesBusy(false);
    }
  }, [id, node]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setInstallError(null);
      const res = await fetchRunnerDetail(id);
      setNode(res.node);
      setName(res.node.name);
      const preferTs = Boolean(res.node.labels?.enableTailscale);
      setWantTailscale(preferTs);
      setContainers(res.containers);
      setMeshAvailable(
        Boolean(res.meshConnected || res.meshProvider === "headscale-platform"),
      );
      if (res.tailscaleError) setInstallError(res.tailscaleError);
      // Install packages are heavy — load separately after detail paints
      if (res.node.kind !== "local" && res.node.access !== "shared") {
        void loadInstall();
      } else {
        setInstallBundle(null);
      }
      // Probe live Runner version/image for the update panel (remote only)
      if (res.node.kind !== "local") {
        void loadVersion();
        void loadImageUpdates();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, loadInstall, loadVersion, loadImageUpdates]);

  useEffect(() => {
    void load();
  }, [load]);

  const install: RunnerInstallPackage | null = installBundle
    ? pickInstallPackage(installBundle, wantTailscale)
    : null;
  const canEnableTailscale = Boolean(installBundle?.installTailscale) || meshAvailable;
  async function save() {
    if (!node) return;
    setBusy(true);
    try {
      const updated = await patchRuntimeNode(node.id, {
        name: name.trim() || node.name,
      });
      setNode(updated);
      setName(updated.name);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isRemoteUpdatable = node?.kind !== "local" && node?.access !== "shared";

  async function handleUpdateRunner() {
    if (!node) return;
    setVersionBusy(true);
    try {
      await updateRunner(node.id);
      toast.success("已调度代理更新，设备将短暂重连");
      setTimeout(() => {
        void loadVersion();
        void loadImageUpdates();
      }, 8_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setVersionBusy(false);
    }
  }

  async function handleRefreshWorkspaceImage() {
    if (!node) return;
    setVersionBusy(true);
    try {
      const result = await refreshWorkspaceImage(node.id, {
        recreateRunning: true,
      });
      toast.success(
        `容器已刷新${result.recreated.length ? `，已重建 ${result.recreated.length} 个` : ""}`,
      );
      void loadImageUpdates();
      void loadContainers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setVersionBusy(false);
    }
  }

  if (loading || !node) {
    return <PageLoading />;
  }

  const host = hostInfoOf(node);
  const interfaces = host.interfaces ?? [];
  const externalIfaces = interfaces.filter((i) => !i.internal);
  const internalIfaces = interfaces.filter((i) => i.internal);
  const needsInstall =
    node.kind !== "local" && (node.status === "offline" || !node.lastSeenAt);
  const isLocal = node.kind === "local";
  const isSharedAccess = node.access === "shared";

  const installSection =
    node.kind !== "local" && !isSharedAccess ? (
      <SettingsSection title="安装">
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <div className="mr-auto flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <Switch
                checked={wantTailscale && canEnableTailscale}
                disabled={!canEnableTailscale}
                onCheckedChange={(v) => setWantTailscale(v)}
                id="detail-ts"
              />
              <Label htmlFor="detail-ts" className="text-xs font-normal">
                {wantTailscale ? "Tailscale 组网" : "公网可达"}
              </Label>
            </div>
            {!canEnableTailscale && installBundle ? (
              <p className="text-[11px] text-muted-foreground">
                {installBundle.tailscaleError ??
                  (!installBundle.meshConnected
                    ? "组网未就绪"
                    : "暂无 Tailscale 安装包")}
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={installBusy}
            onClick={() => void loadInstall()}
          >
            {installBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
        {installError ? (
          <p className="mb-2 text-xs text-destructive whitespace-pre-wrap">{installError}</p>
        ) : null}
        {installBusy && !install ? (
          <PageLoading />
        ) : install ? (
          <RunnerInstallPanel install={install} />
        ) : null}
      </SettingsSection>
    ) : null;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              title="返回"
              nativeButton={false}
              render={<Link href="/dashboard/runners" />}
            >
              <ArrowLeft />
            </Button>
            {node.name}
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCw />
              刷新
            </Button>
            {!isSharedAccess ? (
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="animate-spin" /> : <Save />}
                保存
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(node.status)}>{statusLabel(node.status)}</Badge>
        <Badge variant="outline">{kindLabel(node.kind)}</Badge>
        {isSharedAccess || node.isShared ? (
          <Badge variant="secondary">共享</Badge>
        ) : null}
        {node.agentVersion ? (
          <Badge variant="secondary">v{node.agentVersion}</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground font-mono">{node.id}</span>
      </div>

      {/* Offline / never-seen: install first */}
      {needsInstall ? installSection : null}

      <SettingsSection title="配置">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rn-name">显示名称</Label>
            <Input
              id="rn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={node.kind === "local" || isSharedAccess}
            />
          </div>
          <div className="space-y-1.5">
            <Label>状态</Label>
            <div className="pt-2">
              <Badge variant={statusVariant(node.status)}>{statusLabel(node.status)}</Badge>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-0 divide-y divide-border/60">
          <SettingsField label="节点 ID">
            <code className="text-[11px] text-muted-foreground">{node.id}</code>
          </SettingsField>
          <SettingsField label="Endpoint">
            <span className="max-w-[240px] truncate text-xs font-mono text-muted-foreground">
              {node.endpoint || "—"}
            </span>
          </SettingsField>
          <SettingsField label="存储根目录">
            <code className="text-[11px] text-muted-foreground break-all">
              {node.storageRoot}
            </code>
          </SettingsField>
          <SettingsField label="最近心跳">
            <span className="text-xs text-muted-foreground">
              {node.lastSeenAt
                ? new Date(node.lastSeenAt).toLocaleString()
                : "尚未上报"}
            </span>
          </SettingsField>
          <SettingsField label="创建时间">
            <span className="text-xs text-muted-foreground">
              {new Date(node.createdAt).toLocaleString()}
            </span>
          </SettingsField>
        </div>
      </SettingsSection>

      {isRemoteUpdatable ? (
        <SettingsSection title="版本与镜像">
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={versionBusy}
              onClick={() => void loadVersion()}
            >
              {versionBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重新探测
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={imageUpdatesBusy}
              onClick={() => void loadImageUpdates()}
            >
              {imageUpdatesBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              检查镜像更新
            </Button>
          </div>
          <div className="space-y-0 divide-y divide-border/60">
            <SettingsField label="Runner 版本">
              <div className="flex items-center gap-2">
                {node.agentVersion ? (
                  <Badge variant="secondary">v{node.agentVersion}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">未上报</span>
                )}
                {versionInfo?.live && versionInfo.version ? (
                  <span className="text-xs text-muted-foreground">
                    实时 v{versionInfo.version}
                  </span>
                ) : versionInfo ? (
                  <span className="text-[11px] text-muted-foreground">
                    {versionInfo.live === false ? "Runner 离线或不可达" : ""}
                  </span>
                ) : null}
              </div>
            </SettingsField>
            <SettingsField label="代理二进制">
              <code className="text-[11px] text-muted-foreground break-all">
                {versionInfo?.image || "—"}
              </code>
            </SettingsField>
            <SettingsField label="容器 ID">
              <code className="text-[11px] text-muted-foreground">
                {versionInfo?.containerId?.slice(0, 12) || "—"}
              </code>
            </SettingsField>
          </div>
          {imageUpdates && imageUpdates.length > 0 ? (
            <div className="mt-3 space-y-2">
              {imageUpdates.some((e) => e.updateAvailable) ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                  <div className="text-xs text-warning-foreground">
                    检测到更新。一键更新代理会替换 zakura-agent 并短暂重连；
                    刷新容器会拉取镜像并重建本机上带 zakura 标签的工作区 / MCP / ACP 容器。
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2">
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                  <span className="text-xs text-success">
                    所有镜像均为最新版本
                  </span>
                </div>
              )}
              <div className="space-y-1">
                {imageUpdates.map((entry) => (
                  <div
                    key={entry.image}
                    className="flex items-center justify-between gap-2 rounded border border-border/50 px-3 py-1.5"
                  >
                    <code className="text-[11px] text-muted-foreground break-all">
                      {entry.image}
                    </code>
                    {entry.runningStale ? (
                      <Badge variant="danger" className="shrink-0 text-[10px]">
                        运行容器落后
                      </Badge>
                    ) : entry.updateAvailable ? (
                      <Badge variant="warn" className="shrink-0 text-[10px]">
                        有更新
                      </Badge>
                    ) : entry.error ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {entry.error}
                      </span>
                    ) : (
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>更新代理</Label>
              <Button
                size="sm"
                className="w-full"
                disabled={versionBusy}
                onClick={() => void handleUpdateRunner()}
              >
                {versionBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                一键更新 zakura-agent
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label>刷新容器</Label>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={versionBusy}
                onClick={() => void handleRefreshWorkspaceImage()}
              >
                {versionBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                一键拉取并重建容器
              </Button>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            更新代理从本控制面拉取对应系统的二进制并重启服务，约数秒。
            刷新容器只重建带 zakura 标签的容器，不会动你自己的其它 Docker 应用。
          </p>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={
          <span className="inline-flex w-full items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <Boxes className="size-3.5" />
              容器
            </span>
            <span className="inline-flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={containersBusy}
                onClick={() => void loadContainers()}
              >
                {containersBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                刷新
              </Button>
              {isLocal ? (
                <Button size="sm" onClick={() => setAllocOpen(true)}>
                  <Plus />
                  分配
                </Button>
              ) : null}
            </span>
          </span>
        }
      >
        {!isLocal ? (
          <p className="mb-3 text-[11px] text-muted-foreground">
            远程节点仅展示已绑定容器
          </p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>镜像</TableHead>
              <TableHead>用途</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Docker</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {containers.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="max-w-[160px] truncate text-xs">{r.image}</TableCell>
                <TableCell>
                  <Badge variant="outline">{r.purpose}</Badge>
                </TableCell>
                <TableCell className="text-xs">{r.status}</TableCell>
                <TableCell>
                  <code className="text-[11px]">
                    {r.dockerId ? r.dockerId.slice(0, 12) : "—"}
                  </code>
                </TableCell>
                <TableCell>
                  <TableActions>
                    {r.dockerId && r.status !== "removed" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="停止并移除"
                        onClick={async () => {
                          try {
                            await stopContainer(r.id, true);
                            toast.success("已停止");
                            await loadContainers();
                          } catch (err) {
                            toast.error(
                              err instanceof Error ? err.message : String(err),
                            );
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
            {!containers.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  暂无容器
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1.5">
            <Network className="size-3.5" />
            主机信息
          </span>
        }
      >
        {!host.hostname && !interfaces.length ? (
          <p className="text-xs text-muted-foreground">
            {node.kind === "local"
              ? "本机节点不通过 Runner 心跳上报 hostInfo。"
              : "设备尚未上线，上线后将显示主机名、网卡与磁盘信息。"}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <InfoTile label="主机名" value={host.hostname || "—"} />
              <InfoTile label="主 IP" value={host.primaryIp || "—"} mono />
              <InfoTile
                label="平台"
                value={
                  [host.platform, host.arch].filter(Boolean).join(" / ") || "—"
                }
              />
              <InfoTile
                label="磁盘"
                value={
                  host.disk
                    ? `${formatBytes(host.disk.freeBytes)} 可用 / ${formatBytes(host.disk.totalBytes)}`
                    : "—"
                }
              />
              <InfoTile label="Docker" value={host.dockerVersion || "—"} />
              <InfoTile label="对外 URL" value={host.publicUrl || "—"} mono />
              {host.tailscale ? (
                <InfoTile
                  label="Tailscale"
                  value={
                    host.tailscale.connected
                      ? [host.tailscale.magicDnsName, host.tailscale.ip]
                          .filter(Boolean)
                          .join(" · ") || "已连接"
                      : "未连接"
                  }
                  mono
                />
              ) : null}
            </div>

            {interfaces.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  网卡（{externalIfaces.length} 外部 · {internalIfaces.length}{" "}
                  内部）
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>接口</TableHead>
                      <TableHead>IPv4</TableHead>
                      <TableHead>MAC</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>类型</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...externalIfaces, ...internalIfaces].map((iface) => (
                      <TableRow key={iface.name}>
                        <TableCell className="font-mono text-xs">{iface.name}</TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {iface.ipv4?.length ? iface.ipv4.join(", ") : "—"}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {iface.mac || "—"}
                        </TableCell>
                        <TableCell className="text-xs">{iface.operstate || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={iface.internal ? "secondary" : "outline"}>
                            {iface.internal ? "内部" : "外部"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        )}
      </SettingsSection>

      {/* Online: install section after host info */}
      {!needsInstall ? installSection : null}

      {node.kind !== "local" && !isSharedAccess ? (
        <div className="flex justify-end pt-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={async () => {
              if (!(await confirm({ title: `删除 Runner「${node.name}」？`, description: "需无 Agent 绑定。", confirmLabel: "删除" }))) {
                return;
              }
              try {
                await deleteRuntimeNode(node.id);
                toast.success("已删除");
                router.push("/dashboard/runners");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <Trash2 />
            删除节点
          </Button>
        </div>
      ) : null}

      <Dialog open={allocOpen} onOpenChange={setAllocOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分配容器</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await allocateNodeContainer(node.id, {
                  image: allocForm.image,
                  name: allocForm.name || undefined,
                  purpose: allocForm.purpose,
                  allocatedTo: allocForm.allocatedTo || undefined,
                });
                toast.success("已创建");
                setAllocOpen(false);
                await loadContainers();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <div className="space-y-1.5">
              <Label>镜像</Label>
              <Input
                required
                value={allocForm.image}
                onChange={(e) =>
                  setAllocForm((f) => ({ ...f, image: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input
                  value={allocForm.name}
                  onChange={(e) =>
                    setAllocForm((f) => ({ ...f, name: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>用途</Label>
                <Input
                  value={allocForm.purpose}
                  onChange={(e) =>
                    setAllocForm((f) => ({ ...f, purpose: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Allocated To</Label>
              <Input
                value={allocForm.allocatedTo}
                onChange={(e) =>
                  setAllocForm((f) => ({ ...f, allocatedTo: e.target.value }))
                }
              />
            </div>
            <Button type="submit" className="w-full">
              创建
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoTile({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-sm truncate ${mono ? "font-mono text-xs" : "font-medium"}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
