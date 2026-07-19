"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Cpu,
  Globe,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  createRuntimeNode,
  deleteRuntimeNode,
  formatBytes,
  isRunnerHostInfo,
  kindLabel,
  listRuntimeNodes,
  statusLabel,
  statusVariant,
  type RunnerInstallPackage,
  type RuntimeNode,
} from "@/lib/runners";
import {
  TailscaleMeshPanel,
  type TailscaleMeshReady,
} from "@/components/tailscale-mesh-panel";
import { RunnerInstallPanel } from "@/components/runner-install-panel";
import { SettingsHeader, TableActions } from "@/components/settings-shell";
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
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type AccessMode = "public" | "tailscale" | null;

export default function RunnersPage() {
  const [rows, setRows] = useState<RuntimeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accessMode, setAccessMode] = useState<AccessMode>(null);
  const [meshReady, setMeshReady] = useState(false);
  const [requireTailscale, setRequireTailscale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    node: RuntimeNode;
    token: string;
    install: RunnerInstallPackage | null;
  } | null>(null);

  const load = useCallback(async (silent = false) => {
    try {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setRows(await listRuntimeNodes());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  function resetDialog() {
    setCreated(null);
    setName("");
    setAccessMode(null);
    setMeshReady(false);
    setRequireTailscale(false);
  }

  function onMeshStatus(status: TailscaleMeshReady) {
    setMeshReady(status.ready);
    setRequireTailscale(status.requireTailscale);
    // 平台强制组网时自动锁定到 tailscale
    if (status.requireTailscale) {
      setAccessMode("tailscale");
    }
  }

  const onlineCount = rows.filter((r) => r.status === "online").length;
  const canSubmit =
    Boolean(name.trim()) &&
    accessMode != null &&
    (accessMode === "public" ? !requireTailscale : meshReady);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Runners"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => {
                resetDialog();
                setOpen(true);
              }}
            >
              <Plus />
              注册 Runner
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">节点总数</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">{rows.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">在线</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-success">
            {onlineCount}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground">远程 Runner</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight">
            {rows.filter((r) => r.kind === "runner").length}
          </div>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>名称</TH>
              <TH>类型</TH>
              <TH>状态</TH>
              <TH>主机 / IP</TH>
              <TH>Endpoint</TH>
              <TH>最近心跳</TH>
              <TH className="w-[1%]" />
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => {
              const host = isRunnerHostInfo(r.hostInfo) ? r.hostInfo : {};
              const hostLine =
                host.hostname || host.primaryIp
                  ? [host.hostname, host.primaryIp].filter(Boolean).join(" · ")
                  : "—";
              const disk =
                host.disk?.freeBytes != null
                  ? `可用 ${formatBytes(host.disk.freeBytes)}`
                  : null;
              return (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={`/dashboard/runners/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {r.id}
                    </div>
                  </TD>
                  <TD>
                    <Badge variant="outline">{kindLabel(r.kind)}</Badge>
                  </TD>
                  <TD>
                    <Badge variant={statusVariant(r.status)}>
                      {statusLabel(r.status)}
                    </Badge>
                  </TD>
                  <TD>
                    <div className="text-xs">{hostLine}</div>
                    {disk ? (
                      <div className="text-[11px] text-muted-foreground">{disk}</div>
                    ) : null}
                  </TD>
                  <TD className="max-w-[160px] truncate text-xs font-mono text-muted-foreground">
                    {r.endpoint || "—"}
                  </TD>
                  <TD className="text-xs text-muted-foreground whitespace-nowrap">
                    {r.lastSeenAt
                      ? new Date(r.lastSeenAt).toLocaleString()
                      : "—"}
                  </TD>
                  <TD>
                    <TableActions>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="详情"
                        nativeButton={false}
                        render={<Link href={`/dashboard/runners/${r.id}`} />}
                      >
                        <Server />
                      </Button>
                      {r.kind !== "local" ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="删除"
                          onClick={async () => {
                            if (
                              !confirm(
                                `确定删除 Runner「${r.name}」？需无 Agent 绑定。`,
                              )
                            ) {
                              return;
                            }
                            try {
                              await deleteRuntimeNode(r.id);
                              toast.success("已删除");
                              await load(true);
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : String(err),
                              );
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </TableActions>
                  </TD>
                </TR>
              );
            })}
            {!rows.length ? (
              <TR>
                <TD colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Cpu className="size-8 opacity-40" />
                    <div>暂无 Runner</div>
                  </div>
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetDialog();
        }}
      >
        <DialogContent className="max-w-lg sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{created ? "安装" : "注册 Runner"}</DialogTitle>
          </DialogHeader>

          {created ? (
            <div className="space-y-4">
              {created.install ? (
                <RunnerInstallPanel install={created.install} compact />
              ) : (
                <p className="text-sm text-destructive">无法生成安装命令</p>
              )}
              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link href={`/dashboard/runners/${created.node.id}`} />}
                >
                  查看节点
                </Button>
                <Button onClick={() => setOpen(false)}>完成</Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!name.trim()) {
                  toast.error("请填写名称");
                  return;
                }
                if (!accessMode) {
                  toast.error("请选择访问方式");
                  return;
                }
                if (accessMode === "tailscale" && !meshReady) {
                  toast.error("请先完成 Tailscale 连接");
                  return;
                }
                if (accessMode === "public" && requireTailscale) {
                  toast.error("当前部署要求 Runner 必须加入组网");
                  return;
                }
                setBusy(true);
                try {
                  const res = await createRuntimeNode({
                    name: name.trim(),
                    enableTailscale: accessMode === "tailscale",
                  });
                  setCreated(res);
                  await load(true);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="runner-name">显示名称</Label>
                <Input
                  id="runner-name"
                  placeholder="例如：办公室 Linux 主机"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label>此节点是否有公网？</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={requireTailscale}
                    onClick={() => {
                      setAccessMode("public");
                      setMeshReady(false);
                    }}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                      accessMode === "public"
                        ? "border-foreground/40 bg-muted/60"
                        : "border-border/60 hover:bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Globe className="size-3.5 opacity-70" />
                      有公网
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                      Runner 暴露公网 IP / 域名，Server 直连 HTTP，不加入私有网络。
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAccessMode("tailscale")}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-colors",
                      accessMode === "tailscale"
                        ? "border-foreground/40 bg-muted/60"
                        : "border-border/60 hover:bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Network className="size-3.5 opacity-70" />
                      无公网 / NAT
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                      经 Tailscale 组网，安装脚本自动入网，适合家庭宽带 / 内网主机。
                    </p>
                  </button>
                </div>
              </div>

              {/* 仅在选定「无公网」后才加载组网状态与配置，避免打开弹窗就打慢接口 */}
              {accessMode === "public" ? (
                <div className="rounded-lg border border-border/60 px-3 py-2.5 text-[11px] text-muted-foreground leading-relaxed">
                  {requireTailscale ? (
                    <>当前部署为平台托管组网，远程 Runner 必须加入 Tailscale，请改选「无公网 / NAT」。</>
                  ) : (
                    <>
                      请确保目标机器对 Server 可达（防火墙放行 Runner 端口）。若机器在 NAT
                      后，请改用「无公网 / NAT」。
                    </>
                  )}
                </div>
              ) : null}

              {accessMode === "tailscale" ? (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <div className="text-xs font-medium">组网配置</div>
                  <TailscaleMeshPanel
                    key="runner-register-mesh"
                    compact
                    onStatusChange={onMeshStatus}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    也可在{" "}
                    <Link href="/dashboard/network/mesh" className="underline">
                      网络 → Runner 组网
                    </Link>{" "}
                    管理完整设置。
                  </p>
                </div>
              ) : null}

              <DialogFooter>
                <Button type="submit" className="w-full" disabled={busy || !canSubmit}>
                  {busy ? <Loader2 className="animate-spin" /> : <Plus />}
                  创建 Runner
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
