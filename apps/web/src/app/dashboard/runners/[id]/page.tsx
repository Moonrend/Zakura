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
} from "lucide-react";
import {
  allocateNodeContainer,
  deleteRuntimeNode,
  fetchRunnerDetail,
  fetchRunnerInstall,
  formatBytes,
  isRunnerHostInfo,
  kindLabel,
  listNodeContainers,
  patchRuntimeNode,
  pickInstallPackage,
  statusLabel,
  statusVariant,
  stopContainer,
  type ManagedContainerRow,
  type RunnerHostInfo,
  type RunnerInstallBundle,
  type RunnerInstallPackage,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
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
  const [hostJoinsTailscale, setHostJoinsTailscale] = useState(true);
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

  const loadInstall = useCallback(async () => {
    setInstallBusy(true);
    setInstallError(null);
    try {
      const res = await fetchRunnerInstall(id);
      setInstallBundle(res);
      setHostJoinsTailscale(res.hostJoinsTailscale !== false);
      setMeshAvailable(
        Boolean(res.meshConnected || res.requireTailscale || res.installTailscale),
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
      setHostJoinsTailscale(res.hostJoinsTailscale !== false);
      setMeshAvailable(Boolean(res.meshConnected || res.requireTailscale));
      if (res.tailscaleError) setInstallError(res.tailscaleError);
      // Install packages are heavy — load separately after detail paints
      if (res.node.kind !== "local") {
        void loadInstall();
      } else {
        setInstallBundle(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, loadInstall]);

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

  if (loading || !node) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    );
  }

  const host = hostInfoOf(node);
  const interfaces = host.interfaces ?? [];
  const externalIfaces = interfaces.filter((i) => !i.internal);
  const internalIfaces = interfaces.filter((i) => i.internal);
  const needsInstall =
    node.kind !== "local" && (node.status === "offline" || !node.lastSeenAt);
  const isLocal = node.kind === "local";

  const installSection =
    node.kind !== "local" ? (
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
                    ? "组网未就绪时仅可使用公网安装包"
                    : "暂无 Tailscale 安装包")}
              </p>
            ) : wantTailscale ? (
              <p className="text-[11px] text-muted-foreground">
                {hostJoinsTailscale
                  ? "安装包将自动入网，Server 经私有地址访问"
                  : "主机不入网时，Runner 入网后仍需配置可达的回连地址"}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Runner 需有公网 IP/域名，并在节点配置中填写 endpoint
              </p>
            )}
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
          <Skeleton className="h-40 w-full rounded-lg" />
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
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              保存
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(node.status)}>{statusLabel(node.status)}</Badge>
        <Badge variant="outline">{kindLabel(node.kind)}</Badge>
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
              disabled={node.kind === "local"}
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
            远程节点仅展示已绑定的工作区容器；分配请在本机节点操作，或通过 Agent 工作区启动。
          </p>
        ) : null}
        <Table>
          <THead>
            <TR>
              <TH>名称</TH>
              <TH>镜像</TH>
              <TH>用途</TH>
              <TH>状态</TH>
              <TH>Docker</TH>
              <TH className="w-[1%]" />
            </TR>
          </THead>
          <TBody>
            {containers.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">{r.name}</TD>
                <TD className="max-w-[160px] truncate text-xs">{r.image}</TD>
                <TD>
                  <Badge variant="outline">{r.purpose}</Badge>
                </TD>
                <TD className="text-xs">{r.status}</TD>
                <TD>
                  <code className="text-[11px]">
                    {r.dockerId ? r.dockerId.slice(0, 12) : "—"}
                  </code>
                </TD>
                <TD>
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
                </TD>
              </TR>
            ))}
            {!containers.length && (
              <TR>
                <TD colSpan={6} className="py-6 text-center text-muted-foreground">
                  暂无容器
                </TD>
              </TR>
            )}
          </TBody>
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
                  <THead>
                    <TR>
                      <TH>接口</TH>
                      <TH>IPv4</TH>
                      <TH>MAC</TH>
                      <TH>状态</TH>
                      <TH>类型</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {[...externalIfaces, ...internalIfaces].map((iface) => (
                      <TR key={iface.name}>
                        <TD className="font-mono text-xs">{iface.name}</TD>
                        <TD className="font-mono text-[11px]">
                          {iface.ipv4?.length ? iface.ipv4.join(", ") : "—"}
                        </TD>
                        <TD className="font-mono text-[11px] text-muted-foreground">
                          {iface.mac || "—"}
                        </TD>
                        <TD className="text-xs">{iface.operstate || "—"}</TD>
                        <TD>
                          <Badge variant={iface.internal ? "secondary" : "outline"}>
                            {iface.internal ? "内部" : "外部"}
                          </Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}
          </div>
        )}
      </SettingsSection>

      {/* Online: install section after host info */}
      {!needsInstall ? installSection : null}

      {node.kind !== "local" ? (
        <div className="flex justify-end pt-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={async () => {
              if (!confirm(`确定删除 Runner「${node.name}」？需无 Agent 绑定。`)) {
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
