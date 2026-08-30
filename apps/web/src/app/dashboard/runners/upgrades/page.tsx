"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  checkAllImageUpdates,
  checkNodeImageUpdates,
  fetchGlobalImageUpdates,
  resolveImageUpdateKind,
  kindLabel,
  listRuntimeNodes,
  statusLabel,
  statusVariant,
  upgradeNodeImage,
  type GlobalImageUpdateStatus,
  type ImageUpdateEntry,
  type ImageUpdateNode,
  type RuntimeNode,
} from "@/lib/runners";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { subscribePlatformEvents } from "@/lib/platform-events";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** busy / 结果按 `${nodeId}:${image}` 索引，粒度到单条镜像。 */
type EntryKey = string;
const entryKey = (nodeId: string, image: string) => `${nodeId}:${image}`;

/** 相对时间，"3 分钟前" / "刚检查"。 */
function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "未检查";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚检查";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/** entry 是否需要展示升级按钮。 */
function isActionable(entry: ImageUpdateEntry): boolean {
  return entry.updateAvailable || entry.runningStale;
}

/** 节点能否操作（非 manage 的 shared 不可；local 可刷新工作区镜像）。 */
function canUpgradeImage(node: RuntimeNode, entry: ImageUpdateEntry): boolean {
  if (node.access === "shared") return false;
  if (node.status !== "online") return false;
  // 本机节点没有 Runner 容器可重建。
  if (resolveImageUpdateKind(entry) === "runner") return node.kind !== "local";
  return true;
}

export default function UpgradesPage() {
  const [status, setStatus] = useState<GlobalImageUpdateStatus | null>(null);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingNode, setCheckingNode] = useState<Record<string, boolean>>({});
  const [upgrading, setUpgrading] = useState<Record<EntryKey, boolean>>({});
  const [upgraded, setUpgraded] = useState<Record<EntryKey, boolean>>({});
  const [upgradingAll, setUpgradingAll] = useState(false);

  const loadNodes = useCallback(async () => {
    try {
      setNodes(await listRuntimeNodes());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchGlobalImageUpdates());
    } catch {
      /* 离线或服务不可用：页面仍可用，只是没有镜像检查结果 */
    }
  }, []);

  // 初始加载：节点列表 + 镜像更新状态并行
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      await Promise.all([loadNodes(), loadStatus()]);
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [loadNodes, loadStatus]);

  // 监听 runner_node 事件：节点状态变化时节流刷新两个数据源
  useEffect(() => {
    let last = 0;
    const throttledReload = () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      void loadNodes();
      void loadStatus();
    };
    const unsubscribe = subscribePlatformEvents((ev) => {
      if (ev.type === "runner_node") throttledReload();
    }, throttledReload);
    return unsubscribe;
  }, [loadNodes, loadStatus]);

  const handleCheckAll = useCallback(async () => {
    setCheckingAll(true);
    try {
      const result = await checkAllImageUpdates();
      setStatus(result);
      toast.success(`已检查 ${result.nodes.length} 个节点`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingAll(false);
    }
  }, []);

  const handleCheckNode = useCallback(
    async (nodeId: string) => {
      setCheckingNode((prev) => ({ ...prev, [nodeId]: true }));
      try {
        const result = await checkNodeImageUpdates(nodeId);
        setStatus((prev) => {
          if (!prev) return prev;
          const next = prev.nodes.map((n) =>
            n.nodeId === nodeId ? result : n,
          );
          return {
            ...prev,
            nodes: next,
            hasUpdates: next.some((n) => n.hasUpdates),
            hasRunningStale: next.some((n) => n.hasRunningStale),
          };
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setCheckingNode((prev) => ({ ...prev, [nodeId]: false }));
      }
    },
    [],
  );

  const handleUpgrade = useCallback(
    async (node: RuntimeNode, entry: ImageUpdateEntry) => {
      const key = entryKey(node.id, entry.image);
      setUpgrading((prev) => ({ ...prev, [key]: true }));
      try {
        const { kind, result } = await upgradeNodeImage(node.id, entry);
        if (kind === "runner") {
          toast.success(`${node.name} 的 Runner 镜像已调度更新，Runner 将短暂重连`);
        } else {
          const r = result as { recreated: unknown[] };
          toast.success(
            `${node.name} 的工作区镜像已刷新${r.recreated?.length ? `，已重建 ${r.recreated.length} 个工作区` : ""}`,
          );
        }
        setUpgraded((prev) => ({ ...prev, [key]: true }));
        // 升级后等待 Runner 完成重建再重新探测该节点
        setTimeout(() => void handleCheckNode(node.id), 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`${node.name} 升级失败：${msg}`);
      } finally {
        setUpgrading((prev) => ({ ...prev, [key]: false }));
      }
    },
    [handleCheckNode],
  );

  const statusByNodeId = new Map(status?.nodes.map((n) => [n.nodeId, n]) ?? []);
  const merged = nodes.map((n) => ({
    node: n,
    img: statusByNodeId.get(n.id) ?? null,
  }));

  // 全部更新：并发升级所有节点的待升级镜像条目，单条失败不阻断其余。
  const handleUpgradeAll = useCallback(async () => {
    const pending: Array<{ node: RuntimeNode; entry: ImageUpdateEntry; key: string }> = [];
    for (const { node, img } of merged) {
      if (!img) continue;
      for (const entry of img.entries) {
        if (!isActionable(entry)) continue;
        if (!canUpgradeImage(node, entry)) continue;
        const key = entryKey(node.id, entry.image);
        if (upgraded[key] || upgrading[key]) continue;
        pending.push({ node, entry, key });
      }
    }
    if (!pending.length) return;
    setUpgradingAll(true);
    pending.forEach((p) =>
      setUpgrading((prev) => ({ ...prev, [p.key]: true })),
    );
    let okCount = 0;
    let failCount = 0;
    await Promise.allSettled(
      pending.map(async (p) => {
        try {
          const { kind } = await upgradeNodeImage(p.node.id, p.entry);
          setUpgraded((prev) => ({ ...prev, [p.key]: true }));
          okCount += 1;
          setTimeout(() => void handleCheckNode(p.node.id), kind === "runner" ? 3000 : 1500);
        } catch {
          failCount += 1;
        } finally {
          setUpgrading((prev) => {
            const n = { ...prev };
            delete n[p.key];
            return n;
          });
        }
      }),
    );
    setUpgradingAll(false);
    if (failCount === 0) {
      toast.success(`已升级 ${okCount} 项镜像`);
    } else {
      toast.error(`升级完成：${okCount} 成功，${failCount} 失败`);
    }
  }, [merged, upgraded, upgrading, handleCheckNode]);

  // 待升级条目数：驱动「全部更新」按钮的显隐与禁用。
  const pendingCount = merged.reduce((sum, { node, img }) => {
    if (!img) return sum;
    return (
      sum +
      img.entries.filter((e) => {
        if (!isActionable(e)) return false;
        if (!canUpgradeImage(node, e)) return false;
        const key = entryKey(node.id, e.image);
        return !upgraded[key] && !upgrading[key];
      }).length
    );
  }, 0);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ArrowUpCircle className="size-5 text-warning-foreground" />
            升级中心
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {pendingCount > 0 ? (
              <Button
                size="sm"
                disabled={upgradingAll}
                onClick={() => void handleUpgradeAll()}
              >
                {upgradingAll ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Zap />
                )}
                全部更新
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={checkingAll || loading}
              onClick={() => void handleCheckAll()}
            >
              {checkingAll ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              全部检查
            </Button>
          </div>
        }
      />

      {loading ? (
        <PageLoading />
      ) : merged.length === 0 ? (
        <SettingsSection title="节点镜像状态">
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无可管理的远程 Runner 节点
          </p>
        </SettingsSection>
      ) : (
        <div className="space-y-4">
          {merged.map(({ node, img }) => (
            <NodeCard
              key={node.id}
              node={node}
              img={img}
              checkingNode={Boolean(checkingNode[node.id])}
              upgrading={upgrading}
              upgraded={upgraded}
              onCheckNode={() => void handleCheckNode(node.id)}
              onUpgrade={(entry) => void handleUpgrade(node, entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  img,
  checkingNode,
  upgrading,
  upgraded,
  onCheckNode,
  onUpgrade,
}: {
  node: RuntimeNode;
  img: ImageUpdateNode | null;
  checkingNode: boolean;
  upgrading: Record<EntryKey, boolean>;
  upgraded: Record<EntryKey, boolean>;
  onCheckNode: () => void;
  onUpgrade: (entry: ImageUpdateEntry) => void;
}) {
  const isShared = node.access === "shared";
  const offline = node.status !== "online";

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/dashboard/runners/${node.id}`}
            className="hover:underline"
          >
            {node.name}
          </Link>
          <Badge variant={statusVariant(node.status)} className="text-[10px]">
            {statusLabel(node.status)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {kindLabel(node.kind)}
          </Badge>
          {isShared ? (
            <Badge variant="secondary" className="text-[10px]">
              共享
            </Badge>
          ) : null}
        </span>
      }
      action={
        <span className="inline-flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {relativeTime(img?.checkedAt)}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={checkingNode || offline}
            onClick={onCheckNode}
          >
            {checkingNode ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            检查
          </Button>
        </span>
      }
    >
      {img?.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-xs text-destructive">
            检查失败：{img.error}
          </div>
        </div>
      ) : !img ? (
        <p className="py-3 text-xs text-muted-foreground">
          尚未检查。点击「检查」探测该节点镜像版本。
        </p>
      ) : img.entries.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          无镜像检查结果。
        </p>
      ) : (
        <div className="space-y-1.5">
          {img.entries.map((entry) => (
            <EntryRow
              key={entry.image}
              entry={entry}
              node={node}
              upgrading={Boolean(upgrading[entryKey(node.id, entry.image)])}
              upgraded={Boolean(upgraded[entryKey(node.id, entry.image)])}
              onUpgrade={() => onUpgrade(entry)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function EntryRow({
  entry,
  node,
  upgrading,
  upgraded,
  onUpgrade,
}: {
  entry: ImageUpdateEntry;
  node: RuntimeNode;
  upgrading: boolean;
  upgraded: boolean;
  onUpgrade: () => void;
}) {
  const runnerImage = resolveImageUpdateKind(entry) === "runner";
  const actionable = isActionable(entry);
  const upgradeable = canUpgradeImage(node, entry);
  const disabled = !upgradeable || upgrading;

  let disabledReason: string | undefined;
  if (node.access === "shared") disabledReason = "共享节点，无管理权限";
  else if (node.status !== "online") disabledReason = "节点离线，无法操作";
  else if (runnerImage && node.kind === "local")
    disabledReason = "本机节点无 Runner 容器，无需更新";

  const upgradeBtn = (
    <Button
      size="sm"
      variant={runnerImage ? "default" : "outline"}
      className="h-7 shrink-0 text-xs"
      disabled={disabled}
      onClick={onUpgrade}
    >
      {upgrading ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <RefreshCw className="size-3" />
      )}
      {runnerImage ? "更新 Runner" : "刷新并重建"}
    </Button>
  );

  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/50 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <code className="block text-[11px] text-muted-foreground break-all">
          {entry.image}
        </code>
        <div className="mt-0.5 flex items-center gap-1.5">
          {runnerImage ? (
            <Badge variant="outline" className="text-[10px]">
              Runner
            </Badge>
          ) : null}
          {entry.runningStale ? (
            <Badge variant="danger" className="text-[10px]">
              运行容器落后
            </Badge>
          ) : entry.updateAvailable ? (
            <Badge variant="warn" className="text-[10px]">
              有更新
            </Badge>
          ) : entry.error ? (
            <span className="text-[10px] text-muted-foreground">
              {entry.error}
            </span>
          ) : (
            <CheckCircle2 className="size-3.5 text-emerald-500" />
          )}
        </div>
      </div>
      {actionable ? (
        upgraded ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            已升级
          </span>
        ) : disabledReason && disabled ? (
          <Tooltip>
            <TooltipTrigger render={upgradeBtn} />
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          upgradeBtn
        )
      ) : null}
    </div>
  );
}
