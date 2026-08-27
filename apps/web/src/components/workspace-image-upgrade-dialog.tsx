"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  checkAllImageUpdates,
  checkNodeImageUpdates,
  upgradeNodeImage,
  type ImageUpdateEntry,
  type ImageUpdateNode,
} from "@/lib/runners";

/**
 * ACP Agent 启动失败（多为工作区镜像过旧、未预装 CLI）时弹出的升级对话框。
 * 列出有更新或运行容器落后的节点与镜像，可在弹框内逐条或一键全部升级。
 *
 * 触发：其他组件 dispatch 一个 `zakura:acp-start-failed` CustomEvent。
 */
const TRIGGER_EVENT = "zakura:acp-start-failed";

type Result = { ok: true } | { ok: false; message: string };
const entryKey = (nodeId: string, image: string) => `${nodeId}:${image}`;

/** 待升级的镜像条目：节点 + 条目 + 是否可操作。 */
type PendingItem = {
  key: string;
  node: ImageUpdateNode;
  entry: ImageUpdateEntry;
  disabled: boolean;
};

function collectPending(
  nodes: ImageUpdateNode[],
  results: Record<string, Result>,
): PendingItem[] {
  const out: PendingItem[] = [];
  for (const node of nodes) {
    if (!(node.hasUpdates || node.hasRunningStale)) continue;
    for (const entry of node.entries) {
      if (!(entry.updateAvailable || entry.runningStale)) continue;
      const key = entryKey(node.nodeId, entry.image);
      // 跳过已处理（成功/失败）的条目，全部更新只动未处理的。
      if (results[key]) continue;
      out.push({
        key,
        node,
        entry,
        disabled: node.access === "shared",
      });
    }
  }
  return out;
}

export function WorkspaceImageUpgradeDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<ImageUpdateNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [upgrading, setUpgrading] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [upgradingAll, setUpgradingAll] = useState(false);

  const refreshNode = useCallback(async (nodeId: string) => {
    try {
      const updated = await checkNodeImageUpdates(nodeId);
      setNodes((prev) =>
        prev.map((n) => (n.nodeId === nodeId ? updated : n)),
      );
    } catch {
      /* 重新检查失败不影响已完成的升级 */
    }
  }, []);

  const runCheck = useCallback(async () => {
    setBusy(true);
    try {
      // 走 check-all（POST，强制重新探测）而非读缓存的 GET，避免缓存未命中
      // （刚启动 / local 尚未轮询）时弹框无可操作条目。
      const res = await checkAllImageUpdates();
      setNodes(res.nodes);
    } catch {
      /* 离线或服务不可用：弹框仍可用 */
    } finally {
      setBusy(false);
    }
  }, []);

  const handleUpgrade = useCallback(
    async (node: ImageUpdateNode, entry: ImageUpdateEntry) => {
      const key = entryKey(node.nodeId, entry.image);
      setUpgrading((prev) => ({ ...prev, [key]: true }));
      try {
        const { kind, result } = await upgradeNodeImage(node.nodeId, entry);
        if (kind === "runner") {
          setTimeout(() => void refreshNode(node.nodeId), 3000);
        } else {
          const r = result as { recreated: unknown[] };
          if (r.recreated?.length) {
            setTimeout(() => void refreshNode(node.nodeId), 1500);
          }
        }
        setResults((prev) => ({ ...prev, [key]: { ok: true } }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setResults((prev) => ({ ...prev, [key]: { ok: false, message: msg } }));
      } finally {
        setUpgrading((prev) => ({ ...prev, [key]: false }));
      }
    },
    [refreshNode],
  );

  // 全部更新：并发升级所有未处理的待升级条目，单条失败不阻断其余。
  const handleUpgradeAll = useCallback(async () => {
    const pending = collectPending(nodes, results);
    if (!pending.length) return;
    setUpgradingAll(true);
    pending.forEach((p) =>
      setUpgrading((prev) => ({ ...prev, [p.key]: true })),
    );
    const settled = await Promise.allSettled(
      pending.map((p) => upgradeNodeImage(p.node.nodeId, p.entry)),
    );
    const nextResults = { ...results };
    settled.forEach((s, i) => {
      const p = pending[i]!;
      if (s.status === "fulfilled") {
        nextResults[p.key] = { ok: true };
        if (s.value.kind === "runner") {
          setTimeout(() => void refreshNode(p.node.nodeId), 3000);
        } else {
          const r = s.value.result as { recreated: unknown[] };
          if (r.recreated?.length) {
            setTimeout(() => void refreshNode(p.node.nodeId), 1500);
          }
        }
      } else {
        nextResults[p.key] = {
          ok: false,
          message: s.reason instanceof Error ? s.reason.message : String(s.reason),
        };
      }
      setUpgrading((prev) => {
        const n = { ...prev };
        delete n[p.key];
        return n;
      });
    });
    setResults(nextResults);
    setUpgradingAll(false);
  }, [nodes, results, refreshNode]);

  useEffect(() => {
    const handler = () => {
      setResults({});
      setOpen(true);
      void runCheck();
    };
    window.addEventListener(TRIGGER_EVENT, handler);
    return () => window.removeEventListener(TRIGGER_EVENT, handler);
  }, [runCheck]);

  const actionable = nodes.filter((n) => n.hasUpdates || n.hasRunningStale);
  const pending = useMemo(
    () => collectPending(nodes, results),
    [nodes, results],
  );
  const allDone = actionable.length > 0 && pending.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-warning-foreground" />
            工作区镜像可能过旧
          </DialogTitle>
          <DialogDescription>
            下列镜像有更新或运行容器落后，可直接升级。
          </DialogDescription>
        </DialogHeader>

        {actionable.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {allDone
                  ? "全部镜像已升级"
                  : `${pending.length} 项待升级`}
              </span>
              {pending.length > 0 ? (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={upgradingAll}
                  onClick={() => void handleUpgradeAll()}
                >
                  {upgradingAll ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  全部更新
                </Button>
              ) : null}
            </div>
            <ScrollArea className="max-h-[40vh]">
              <div className="space-y-3 pr-3">
                {actionable.map((node) => {
                  const entries = node.entries.filter(
                    (e) => e.updateAvailable || e.runningStale,
                  );
                  return (
                    <div key={node.nodeId} className="space-y-1.5">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span>{node.nodeName ?? node.nodeId}</span>
                        {node.access === "shared" ? (
                          <Badge variant="secondary" className="text-[10px]">
                            共享
                          </Badge>
                        ) : null}
                      </div>
                      {entries.map((entry) => {
                        const key = entryKey(node.nodeId, entry.image);
                        const isUpgrading = upgrading[key];
                        const result = results[key];
                        return (
                          <div
                            key={entry.image}
                            className="flex items-center justify-between gap-2 rounded border border-border/50 px-2.5 py-1.5"
                          >
                            <div className="min-w-0 flex-1">
                              <code className="text-[11px] text-muted-foreground break-all">
                                {entry.image}
                              </code>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                {entry.runningStale ? (
                                  <Badge variant="danger" className="text-[10px]">
                                    运行容器落后
                                  </Badge>
                                ) : (
                                  <Badge variant="warn" className="text-[10px]">
                                    有更新
                                  </Badge>
                                )}
                              </div>
                            </div>
                            {result?.ok ? (
                              <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="size-3.5" />
                                已升级
                              </span>
                            ) : result ? (
                              <Tooltip>
                                <TooltipTrigger render={
                                  <span
                                    className="shrink-0 text-[10px] text-destructive"
                                  >
                                    失败
                                  </span>
                                } />
                                <TooltipContent>{result.message}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 shrink-0 text-xs"
                                disabled={isUpgrading || node.access === "shared"}
                                onClick={() => void handleUpgrade(node, entry)}
                              >
                                {isUpgrading ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="size-3" />
                                )}
                                升级
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </>
        ) : busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在检查节点镜像状态…
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            未检测到镜像更新。可能镜像内未预装 Agent CLI 或协议不兼容，建议到升级中心手动刷新并重试。
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            稍后处理
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setOpen(false);
              router.push("/dashboard/runners/upgrades");
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            前往升级中心
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 通知升级对话框触发一次镜像检查（供 acpError 等场景调用）。 */
export function notifyAcpStartFailed(): void {
  window.dispatchEvent(new CustomEvent(TRIGGER_EVENT));
}
