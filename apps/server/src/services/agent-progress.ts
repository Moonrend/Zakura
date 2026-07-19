export type ProgressLevel = "info" | "warn" | "error" | "ok";

export interface ProgressEvent {
  ts: number;
  level: ProgressLevel;
  step: string;
  message: string;
  percent?: number;
}

export interface AgentProgressSnapshot {
  agentId: string;
  phase: string;
  percent: number;
  running: boolean;
  done: boolean;
  error: string | null;
  events: ProgressEvent[];
  updatedAt: number;
}

const store = new Map<string, AgentProgressSnapshot>();
const MAX_EVENTS = 200;

function empty(agentId: string): AgentProgressSnapshot {
  return {
    agentId,
    phase: "idle",
    percent: 0,
    running: false,
    done: false,
    error: null,
    events: [],
    updatedAt: Date.now(),
  };
}

export function getAgentProgress(agentId: string): AgentProgressSnapshot {
  return store.get(agentId) ?? empty(agentId);
}

export function beginAgentProgress(agentId: string, phase = "starting"): void {
  store.set(agentId, {
    ...empty(agentId),
    phase,
    running: true,
    percent: 0,
    updatedAt: Date.now(),
  });
}

export function logAgentProgress(
  agentId: string,
  step: string,
  message: string,
  opts?: { level?: ProgressLevel; percent?: number; phase?: string },
): void {
  const cur = store.get(agentId) ?? empty(agentId);
  const percent =
    opts?.percent !== undefined ? Math.max(0, Math.min(100, opts.percent)) : cur.percent;
  const event: ProgressEvent = {
    ts: Date.now(),
    level: opts?.level ?? "info",
    step,
    message,
    percent,
  };
  const events = [...cur.events, event].slice(-MAX_EVENTS);
  store.set(agentId, {
    ...cur,
    phase: opts?.phase ?? cur.phase,
    percent,
    running: true,
    done: false,
    error: null,
    events,
    updatedAt: Date.now(),
  });
}

export function finishAgentProgress(
  agentId: string,
  result: { ok: true; message?: string } | { ok: false; error: string },
): void {
  const cur = store.get(agentId) ?? empty(agentId);
  const event: ProgressEvent = {
    ts: Date.now(),
    level: result.ok ? "ok" : "error",
    step: result.ok ? "done" : "failed",
    message: result.ok ? (result.message ?? "完成") : result.error,
    percent: result.ok ? 100 : cur.percent,
  };
  store.set(agentId, {
    ...cur,
    phase: result.ok ? "done" : "error",
    percent: result.ok ? 100 : cur.percent,
    running: false,
    done: true,
    error: result.ok ? null : result.error,
    events: [...cur.events, event].slice(-MAX_EVENTS),
    updatedAt: Date.now(),
  });
}

export function clearAgentProgress(agentId: string): void {
  store.delete(agentId);
}
