"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

type UseAutoSaveOptions = {
  /** Debounce for text-like changes; switches/selects should call flush/saveNow */
  debounceMs?: number;
  /** How long to show "已保存" before returning to idle */
  savedMs?: number;
};

/**
 * Debounced auto-save with status for settings UIs.
 * - schedule(patch) queues a save after debounce
 * - saveNow(patch) saves immediately (switches / selects)
 */
export function useAutoSave<T extends Record<string, unknown>>(
  save: (patch: Partial<T>) => Promise<void>,
  options?: UseAutoSaveOptions,
) {
  const debounceMs = options?.debounceMs ?? 500;
  const savedMs = options?.savedMs ?? 1600;
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef<Partial<T>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const inflightRef = useRef(false);
  const chainRef = useRef(false);

  const clearDebounce = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runSave = useCallback(async () => {
    if (inflightRef.current) {
      chainRef.current = true;
      return;
    }
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(patch).length === 0) return;

    inflightRef.current = true;
    setStatus("saving");
    setError(null);
    try {
      await saveRef.current(patch);
      // Drain anything queued while we were saving
      while (Object.keys(pendingRef.current).length > 0 || chainRef.current) {
        chainRef.current = false;
        const next = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(next).length === 0) continue;
        await saveRef.current(next);
      }
      setStatus("saved");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus("idle"), savedMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    } finally {
      inflightRef.current = false;
      // Late arrivals after finally: schedule another pass
      if (Object.keys(pendingRef.current).length > 0 || chainRef.current) {
        chainRef.current = false;
        void runSave();
      }
    }
  }, [savedMs]);

  const schedule = useCallback(
    (patch: Partial<T>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      setStatus((s) => (s === "saving" ? s : "dirty"));
      clearDebounce();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void runSave();
      }, debounceMs);
    },
    [clearDebounce, debounceMs, runSave],
  );

  const saveNow = useCallback(
    (patch: Partial<T>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      clearDebounce();
      void runSave();
    },
    [clearDebounce, runSave],
  );

  const flush = useCallback(() => {
    clearDebounce();
    void runSave();
  }, [clearDebounce, runSave]);

  useEffect(() => {
    return () => {
      clearDebounce();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [clearDebounce]);

  return { status, error, schedule, saveNow, flush };
}
