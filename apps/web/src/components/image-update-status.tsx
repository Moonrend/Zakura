"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { hasImageProbeErrors } from "@zakura/shared";
import { fetchGlobalImageUpdates, type GlobalImageUpdateStatus } from "@/lib/runners";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export type ImageUpdateSummary = {
  /** Nodes with at least one newer image on the registry. */
  nodesWithUpdates: number;
  /** Nodes whose running workspace lags the image already pulled. */
  nodesNeedingRecreate: number;
  /** A probe failed somewhere — state is unknown, not "current". */
  hasErrors: boolean;
  loading: boolean;
};

const EMPTY: ImageUpdateSummary = {
  nodesWithUpdates: 0,
  nodesNeedingRecreate: 0,
  hasErrors: false,
  loading: true,
};

const ImageUpdateContext = createContext<ImageUpdateSummary>(EMPTY);

function summarize(status: GlobalImageUpdateStatus | null): ImageUpdateSummary {
  if (!status) return EMPTY;
  return {
    nodesWithUpdates: status.nodes.filter((n) => n.hasUpdates).length,
    // Counted separately: an image can be pulled while the container still runs
    // the old one. The old banner fetched this and then ignored it, so that state
    // was invisible even though it is the one requiring an explicit recreate.
    nodesNeedingRecreate: status.nodes.filter((n) => n.hasRunningStale).length,
    hasErrors: status.hasErrors ?? status.nodes.some((n) => hasImageProbeErrors(n)),
    loading: false,
  };
}

/**
 * Polls image-update state once for the whole app.
 *
 * Previously each mount of the floating banner polled on its own, and it was
 * mounted twice (dashboard layout + chat), so the same endpoint was hit twice per
 * interval and the two copies could disagree.
 */
export function ImageUpdateProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<GlobalImageUpdateStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchGlobalImageUpdates());
    } catch {
      // Leave the previous value: a transient fetch failure must not read as
      // "everything is up to date".
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const value = useMemo(() => summarize(status), [status]);
  return <ImageUpdateContext.Provider value={value}>{children}</ImageUpdateContext.Provider>;
}

export function useImageUpdateStatus(): ImageUpdateSummary {
  return useContext(ImageUpdateContext);
}

/**
 * The state, shown where the action lives (the 升级中心 nav item) instead of as a
 * floating card.
 *
 * A dismissible overlay was the wrong shape for this: it covered content, its
 * dismissal was global for 4 hours (so a new update on another node stayed hidden
 * too), and once dismissed there was no trace of the state anywhere in the UI. A
 * count on the nav item is always visible, never in the way, and points at the
 * page that can act on it.
 */
export function ImageUpdateIndicator({ className }: { className?: string }) {
  const { nodesWithUpdates, nodesNeedingRecreate, hasErrors } = useImageUpdateStatus();
  const count = nodesWithUpdates || nodesNeedingRecreate;
  if (!count && !hasErrors) return null;

  const title = nodesWithUpdates
    ? `${nodesWithUpdates} 个节点有镜像更新`
    : nodesNeedingRecreate
      ? `${nodesNeedingRecreate} 个节点需重建工作区以生效`
      : "部分节点镜像状态未知（探测失败）";

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded px-1 text-[10px] font-medium tabular-nums",
        count
          ? "bg-foreground/10 text-foreground"
          : "bg-transparent text-muted-foreground",
        className,
      )}
    >
      {count || "?"}
    </span>
  );
}
