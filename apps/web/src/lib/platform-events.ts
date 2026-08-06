"use client";

/**
 * 平台事件订阅（SSE /api/events）：整页共享一条连接，引用计数管理。
 * 事件为瞬态信号 —— 断线重连后消费方应重新拉一次快照接口对齐状态
 * （onReconnect 回调即为此设计）。
 */
import type { ProgressSnapshot } from "@/lib/agents";

export type PlatformServiceProgressSnapshot = {
  serviceKey: string;
  phase: string;
  percent: number;
  running: boolean;
  done: boolean;
  error: string | null;
  message: string;
  events: Array<{
    ts: number;
    level: string;
    step: string;
    message: string;
    percent?: number;
  }>;
  updatedAt: number;
};

export type PlatformEvent =
  | { type: "agent_progress"; ts: number; agentId: string; snapshot: ProgressSnapshot }
  | {
      type: "mcp_instance";
      ts: number;
      instanceId: string;
      slug: string;
      providerId: string;
      status: string;
      message?: string;
    }
  | {
      type: "mcp_progress";
      ts: number;
      instanceId: string;
      slug: string;
      step: string;
      message: string;
      level: "info" | "warn" | "error" | "ok";
    }
  | {
      type: "platform_service_progress";
      ts: number;
      serviceKey: string;
      snapshot: PlatformServiceProgressSnapshot;
    }
  | { type: "runner_node"; ts: number; nodeId: string }
  | { type: "agent_fs_changed"; ts: number; agentId: string; path: string }
  | {
      type: "cloud_session_changed";
      ts: number;
      agentId: string;
      sessionId: string;
      reason?: "created" | "updated";
    };

type Subscriber = {
  onEvent: (ev: PlatformEvent) => void;
  /** 连接（重）建立时回调：用于重新拉快照对齐状态 */
  onReconnect?: () => void;
};

const subscribers = new Set<Subscriber>();
let ctrl: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;
let everConnected = false;
let listenersBound = false;

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("zakura_session");
}

function scheduleReconnect() {
  if (subscribers.size === 0 || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 15_000);
}

function connect() {
  if (subscribers.size === 0 || ctrl) return;
  const controller = new AbortController();
  ctrl = controller;

  void (async () => {
    try {
      const token = getToken();
      const res = await fetch("/api/events", {
        headers: {
          Accept: "text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);

      backoffMs = 1000;
      if (everConnected) {
        for (const s of subscribers) s.onReconnect?.();
      }
      everConnected = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim() || part.startsWith(":")) continue;
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (eventName !== "platform" || dataLines.length === 0) continue;
          try {
            const ev = JSON.parse(dataLines.join("\n")) as PlatformEvent;
            for (const s of subscribers) {
              try {
                s.onEvent(ev);
              } catch {
                /* subscriber error */
              }
            }
          } catch {
            /* malformed */
          }
        }
      }
    } catch {
      /* aborted or network error */
    } finally {
      if (ctrl === controller) ctrl = null;
      scheduleReconnect();
    }
  })();
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ctrl?.abort();
  ctrl = null;
}

function bindGlobalListeners() {
  if (listenersBound || typeof document === "undefined") return;
  listenersBound = true;
  // 回到前台时立即重连（免等退避），保证状态新鲜
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || subscribers.size === 0) return;
    if (!ctrl) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      backoffMs = 1000;
      connect();
    }
  });
}

/**
 * 订阅平台事件。返回退订函数；最后一个订阅者退订时关闭连接。
 */
export function subscribePlatformEvents(
  onEvent: (ev: PlatformEvent) => void,
  onReconnect?: () => void,
): () => void {
  const sub: Subscriber = { onEvent, onReconnect };
  subscribers.add(sub);
  bindGlobalListeners();
  connect();
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) disconnect();
  };
}
