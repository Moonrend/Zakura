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
import { subscribePlatformEvents } from "@/lib/platform-events";
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchField } from "@/components/ui/search-field";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { cn } from "@/lib/utils";

type AccessMode = "public" | "tailscale" | null;

export default function RunnersPage() {
  const [rows, setRows] = useState<RuntimeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const filtered = useFuzzySearch(rows, q, {
    keys: [
      { name: "name", weight: 3 },
      { name: "kind", weight: 1 },
      { name: "hostInfo.hostname", weight: 2 },
      { name: "hostInfo.primaryIp", weight: 2 },
      { name: "endpoint", weight: 1 },
    ],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accessMode, setAccessMode] = useState<AccessMode>(null);
  const [meshReady, setMeshReady] = useState(false);
  const [platformMode, setPlatformMode] = useState(false);
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

  // Runner 心跳经平台事件推送；回到前台时刷新一次，不再定时轮询
  useEffect(() => {
    void load();
    let last = 0;
    const throttledReload = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void load(true);
    };
    const unsubscribe = subscribePlatformEvents((ev) => {
      if (ev.type === "runner_node") throttledReload();
    }, throttledReload);
    const onVisibility = () => {
      if (document.visibilityState === "visible") throttledReload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  function resetDialog() {
    setCreated(null);
    setName("");
    setAccessMode(null);
    setMeshReady(false);
    setPlatformMode(false);
  }

  function onMeshStatus(status: TailscaleMeshReady) {
    setMeshReady(status.ready);
    setPlatformMode(status.platformMode);
    if (status.platformMode) {
      setAccessMode("tailscale");
    }
  }

  const onlineCount = rows.filter((r) => r.status === "online").length;
  const canSubmit =
    Boolean(name.trim()) &&
    accessMode != null &&
    (accessMode === "public" ? !platformMode : meshReady);

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
        <>
          {rows.length > 5 ? (
            <SearchField
              value={q}
              onValueChange={setQ}
              placeholder="搜索 Runner（名称、主机、IP）"
              className="max-w-sm"
            />
          ) : null}
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>主机 / IP</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>最近心跳</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => {
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
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/runners/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {r.id}
                    </div>
                    {r.access === "shared" || r.isShared ? (
                      <Badge variant="secondary" className="mt-1">
                        共享
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{kindLabel(r.kind)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>
                      {statusLabel(r.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs">{hostLine}</div>
                    {disk ? (
                      <div className="text-[11px] text-muted-foreground">{disk}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate text-xs font-mono text-muted-foreground">
                    {r.endpoint || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {r.lastSeenAt
                      ? new Date(r.lastSeenAt).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>
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
                      {r.kind !== "local" && r.access !== "shared" ? (
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
                  </TableCell>
                </TableRow>
              );
            })}
            {!filtered.length ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Cpu className="size-8 opacity-40" />
                    <div>{rows.length ? `没有匹配「${q}」的 Runner` : "暂无 Runner"}</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
          </Table>
        </>
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
                if (accessMode === "public" && platformMode) {
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
                <Label>访问方式</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={platformMode}
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
                  </button>
                </div>
              </div>

              {/* 仅在选定「无公网」后才加载组网状态与配置，避免打开弹窗就打慢接口 */}
              {accessMode === "public" && platformMode ? (
                <div className="rounded-lg border border-border/60 px-3 py-2.5 text-[11px] text-muted-foreground">
                  平台托管组网下请改选「无公网 / NAT」
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
