"use client";

/**
 * 平台事件订阅：整页共享一条 Socket.IO 连接（room `tenant:<id>`），引用计数管理。
 * 事件为瞬态信号 —— 断线重连后消费方应重新拉一次快照接口对齐状态
 * （onReconnect 回调即为此设计）。
 */
import type { Socket } from "socket.io-client";
import { acquireSocket } from "@/lib/socket";
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
    }
  | {
      type: "connector_inbound";
      ts: number;
      agentId: string;
      sessionId: string;
      platform: string;
      title: string;
      preview?: string;
    }
  | {
      type: "browser_notify";
      ts: number;
      agentId: string;
      title: string;
      body?: string;
      url?: string;
    };

type Subscriber = {
  onEvent: (ev: PlatformEvent) => void;
  /** 连接（重）建立时回调：用于重新拉快照对齐状态 */
  onReconnect?: () => void;
};

const subscribers = new Set<Subscriber>();
let handle: { socket: Socket; release: () => void } | null = null;
let everConnected = false;

function handleEvent(ev: PlatformEvent) {
  for (const s of subscribers) {
    try {
      s.onEvent(ev);
    } catch {
      /* subscriber error */
    }
  }
}

function handleConnect() {
  // 首次连接不算重连：onReconnect 语义是「补拉快照对齐」
  if (everConnected) {
    for (const s of subscribers) s.onReconnect?.();
  }
  everConnected = true;
}

/**
 * 订阅平台事件。返回退订函数；最后一个订阅者退订时释放共享连接。
 *
 * 事件为瞬态信号，服务端不做重放 —— 断线重连后消费方应在 onReconnect 里
 * 重新拉一次快照接口对齐状态。
 */
export function subscribePlatformEvents(
  onEvent: (ev: PlatformEvent) => void,
  onReconnect?: () => void,
): () => void {
  const sub: Subscriber = { onEvent, onReconnect };
  subscribers.add(sub);

  if (!handle) {
    handle = acquireSocket();
    // 已处于连接态（例如 chat 仍持有该连接）⇒ 下一次 connect 事件必然是「重连」，
    // 必须补拉快照。这里若固定播种 false，重新订阅后的首次重连会静默跳过
    // onReconnect，消费方将一直渲染陈旧状态。
    everConnected = handle.socket.connected;
    handle.socket.on("platform", handleEvent);
    handle.socket.on("connect", handleConnect);
  }

  return () => {
    subscribers.delete(sub);
    if (subscribers.size > 0 || !handle) return;
    handle.socket.off("platform", handleEvent);
    handle.socket.off("connect", handleConnect);
    handle.release();
    handle = null;
  };
}
