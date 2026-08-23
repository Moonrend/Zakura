"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, AlertCircle } from "lucide-react";
import {
  fetchGlobalImageUpdates,
  type GlobalImageUpdateStatus,
} from "@/lib/runners";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "zakura:image-update-dismissed";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function ImageUpdateBanner() {
  const router = useRouter();
  const [status, setStatus] = useState<GlobalImageUpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Read dismissed state from localStorage (per-node)
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { until: number };
        if (parsed.until > Date.now()) setDismissed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetchGlobalImageUpdates();
      setStatus(res);
    } catch {
      /* offline or not available */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(
        DISMISS_KEY,
        JSON.stringify({ until: Date.now() + 4 * 60 * 60 * 1000 }),
      );
    } catch {
      /* ignore */
    }
  }, []);

  if (!status || !status.hasUpdates || dismissed) return null;

  const updateableNodes = status.nodes.filter((n) => n.hasUpdates);

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 shadow-lg">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-warning-foreground" />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium text-warning-foreground">
            {updateableNodes.length} 个节点有镜像更新可用
          </p>
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                router.push("/dashboard/runners/upgrades");
              }}
            >
              去更新
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={dismiss}
            >
              稍后提醒
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
