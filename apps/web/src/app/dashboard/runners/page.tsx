"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Cpu, MoreHorizontal, Plus } from "lucide-react";
import {
  deleteNodeDescription,
  deleteRuntimeNode,
  formatBytes,
  isRunnerHostInfo,
  listRuntimeNodes,
  statusLabel,
  type RuntimeNode,
} from "@/lib/runners";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { subscribePlatformEvents } from "@/lib/platform-events";
import { useImageUpdateStatus } from "@/components/image-update-status";
import { AddDeviceDialog } from "@/components/add-device-dialog";
import { NodeStatusDot } from "@/components/node-status-dot";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { PageLoading } from "@/components/ui/progress-linear";
import { SearchField } from "@/components/ui/search-field";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";

export default function RunnersPage() {
  const router = useRouter();
  const { confirm } = useConfirmDialog();
  const updates = useImageUpdateStatus();
  const [rows, setRows] = useState<RuntimeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const filtered = useFuzzySearch(rows, q, {
    keys: [
      { name: "name", weight: 3 },
      { name: "hostInfo.hostname", weight: 2 },
      { name: "hostInfo.primaryIp", weight: 2 },
    ],
  });

  const load = useCallback(async () => {
    try {
      setRows(await listRuntimeNodes());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 心跳经平台事件推送；回到前台时刷新一次，不定时轮询，也不需要手动刷新按钮
  useEffect(() => {
    void load();
    let last = 0;
    const throttledReload = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void load();
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

  async function remove(node: RuntimeNode) {
    if (!(await confirm({ title: `删除「${node.name}」？`, description: deleteNodeDescription, confirmLabel: "删除" }))) return;
    try {
      await deleteRuntimeNode(node.id);
      toast.success("已删除");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const pendingUpdates = updates.nodesWithUpdates || updates.nodesNeedingRecreate;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="设备"
        description="安装 zakura-agent 的电脑或服务器，为空间提供工作区和数据盘。"
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            添加设备
          </Button>
        }
      />

      {pendingUpdates ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-4 py-3 shadow-surface-2">
          <p className="text-sm">
            {updates.nodesWithUpdates
              ? `${updates.nodesWithUpdates} 台设备有可用更新`
              : `${updates.nodesNeedingRecreate} 台设备需重建容器以使用新版本`}
          </p>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/dashboard/runners/upgrades" />}>
            查看更新
          </Button>
        </div>
      ) : null}

      {loading ? (
        <PageLoading />
      ) : !rows.length ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-card px-6 py-12 text-center shadow-surface-2">
          <Cpu className="size-8 text-muted-foreground/60" />
          <div className="space-y-1">
            <p className="text-sm font-medium">还没有设备</p>
            <p className="text-sm text-muted-foreground">在任意 Linux、macOS 或 Windows 机器上运行一条安装命令即可接入。</p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            添加设备
          </Button>
        </div>
      ) : (
        <>
          {rows.length > 5 ? (
            <SearchField value={q} onValueChange={setQ} placeholder="搜索名称、主机名或 IP" className="max-w-sm" />
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">系统</TableHead>
                <TableHead className="hidden md:table-cell">可用磁盘</TableHead>
                <TableHead className="hidden sm:table-cell">最近在线</TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const host = isRunnerHostInfo(r.hostInfo) ? r.hostInfo : {};
                const hostLine = [host.hostname, host.primaryIp].filter(Boolean).join(" · ");
                const manageable = r.kind !== "local" && r.access !== "shared";
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/dashboard/runners/${r.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/dashboard/runners/${r.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.name}
                        </Link>
                        {r.access === "shared" || r.isShared ? <Badge variant="secondary">共享</Badge> : null}
                        {r.needsReinstall ? <Badge variant="destructive">需重装</Badge> : null}
                      </div>
                      {hostLine ? <div className="text-xs text-muted-foreground">{hostLine}</div> : null}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <NodeStatusDot status={r.status} />
                        {r.lastSeenAt || r.kind === "local" ? statusLabel(r.status) : "等待安装"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {[host.platform, host.arch].filter(Boolean).join(" / ") || "—"}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground tabular-nums md:table-cell">
                      {host.disk?.freeBytes != null ? formatBytes(host.disk.freeBytes) : "—"}
                    </TableCell>
                    <TableCell
                      className="hidden text-xs text-muted-foreground whitespace-nowrap sm:table-cell"
                      title={formatAbsolute(r.lastSeenAt)}
                    >
                      {r.status === "online" ? "现在" : formatRelative(r.lastSeenAt)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {manageable ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="设备操作" />}>
                            <MoreHorizontal />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-auto min-w-32">
                            <DropdownMenuItem render={<Link href={`/dashboard/runners/${r.id}`} />}>详情</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => void remove(r)}>删除</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!filtered.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    没有匹配「{q}」的设备
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </>
      )}

      <AddDeviceDialog
        open={adding}
        onOpenChange={setAdding}
        nodes={rows}
        onCreated={() => void load()}
      />
    </div>
  );
}
