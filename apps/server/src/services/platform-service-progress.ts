/**
 * In-memory deploy progress for host-level platform services.
 * Mirrors agent-progress: SSE pushes snapshots; reconnect → re-fetch GET snapshot.
 */
import type { PlatformServiceKey } from "@zakura/shared";
import { platformEvents } from "./platform-events.js";

export type ProgressLevel = "info" | "warn" | "error" | "ok";

export type PlatformServiceProgressEvent = {
  ts: number;
  level: ProgressLevel;
  step: string;
  message: string;
  percent?: number;
};

export type PlatformServiceProgressSnapshot = {
  serviceKey: string;
  /** idle | checking | pulling | creating | starting | health | stopping | done | error */
  phase: string;
  percent: number;
  running: boolean;
  done: boolean;
  error: string | null;
  message: string;
  events: PlatformServiceProgressEvent[];
  updatedAt: number;
};

const store = new Map<string, PlatformServiceProgressSnapshot>();
const MAX_EVENTS = 400;

function empty(serviceKey: string): PlatformServiceProgressSnapshot {
  return {
    serviceKey,
    phase: "idle",
    percent: 0,
    running: false,
    done: false,
    error: null,
    message: "",
    events: [],
    updatedAt: Date.now(),
  };
}

function publish(serviceKey: string): void {
  const snapshot = store.get(serviceKey) ?? empty(serviceKey);
  platformEvents.publishAll({
    type: "platform_service_progress",
    serviceKey,
    snapshot,
  });
}

export function getPlatformServiceProgress(
  serviceKey: string,
): PlatformServiceProgressSnapshot {
  return store.get(serviceKey) ?? empty(serviceKey);
}

export function beginPlatformServiceProgress(
  serviceKey: PlatformServiceKey | string,
  phase = "checking",
  message = "准备中…",
): void {
  store.set(serviceKey, {
    ...empty(serviceKey),
    phase,
    message,
    running: true,
    percent: 2,
    updatedAt: Date.now(),
  });
  publish(serviceKey);
}

export function logPlatformServiceProgress(
  serviceKey: string,
  step: string,
  message: string,
  opts?: { level?: ProgressLevel; percent?: number; phase?: string },
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  const percent =
    opts?.percent !== undefined
      ? Math.max(0, Math.min(100, opts.percent))
      : cur.percent;
  const event: PlatformServiceProgressEvent = {
    ts: Date.now(),
    level: opts?.level ?? "info",
    step,
    message,
    percent,
  };
  store.set(serviceKey, {
    ...cur,
    phase: opts?.phase ?? cur.phase,
    percent,
    // Keep last human-readable status line short; full trail is events
    message: message.slice(0, 500),
    running: true,
    done: false,
    error: null,
    events: [...cur.events, event].slice(-MAX_EVENTS),
    updatedAt: Date.now(),
  });
  publish(serviceKey);
}

/** Append a raw docker/engine log line (no canned copy). */
export function appendPlatformServiceLog(
  serviceKey: string,
  line: string,
  opts?: { step?: string; level?: ProgressLevel; phase?: string; percent?: number },
): void {
  const text = line.replace(/\r/g, "").trimEnd();
  if (!text.trim()) return;
  // Split multi-line blobs into individual events
  for (const part of text.split("\n")) {
    const msg = part.trimEnd();
    if (!msg.trim()) continue;
    logPlatformServiceProgress(serviceKey, opts?.step ?? "log", msg, {
      level: opts?.level ?? "info",
      phase: opts?.phase,
      percent: opts?.percent,
    });
  }
}

export function setPlatformServicePhase(
  serviceKey: string,
  phase: string,
  percent?: number,
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  store.set(serviceKey, {
    ...cur,
    phase,
    percent: percent ?? cur.percent,
    running: true,
    done: false,
    updatedAt: Date.now(),
  });
  publish(serviceKey);
}

export function finishPlatformServiceProgress(
  serviceKey: string,
  opts?: { error?: string | null; message?: string },
): void {
  const cur = store.get(serviceKey) ?? empty(serviceKey);
  const error = opts?.error ?? null;
  const finalEvent: PlatformServiceProgressEvent = {
    ts: Date.now(),
    level: error ? "error" : "ok",
    step: error ? "error" : "done",
    message: opts?.message ?? (error ? error : "完成"),
    percent: 100,
  };
  store.set(serviceKey, {
    ...cur,
    phase: error ? "error" : "done",
    percent: 100,
    running: false,
    done: true,
    error,
    message: opts?.message ?? (error ? error : "完成"),
    events: [...cur.events, finalEvent].slice(-MAX_EVENTS),
    updatedAt: Date.now(),
  });
  publish(serviceKey);
}
