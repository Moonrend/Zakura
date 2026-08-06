/**
 * 平台事件总线：租户级进程内 pub/sub + SSE fan-out。
 * 用于把长任务进度（MCP 安装/启动、Agent 工作区拉起）与状态变化
 * 实时推给前端，取代前端轮询。事件是瞬态信号，不落库：
 * 断线重连后前端应重新拉一次快照接口对齐状态。
 */
import type { AgentProgressSnapshot } from "./agent-progress.js";

import type { PlatformServiceProgressSnapshot } from "./platform-service-progress.js";

export type PlatformEvent =
  | {
      type: "agent_progress";
      ts: number;
      agentId: string;
      snapshot: AgentProgressSnapshot;
    }
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
      /** Host-level platform service deploy/stop progress (all tenants receive). */
      type: "platform_service_progress";
      ts: number;
      serviceKey: string;
      snapshot: PlatformServiceProgressSnapshot;
    }
  | { type: "runner_node"; ts: number; nodeId: string }
  | { type: "agent_fs_changed"; ts: number; agentId: string; path: string }
  | {
      /** Cloud Agent / Gateway 会话列表变化（新建或有实质消息） */
      type: "cloud_session_changed";
      ts: number;
      agentId: string;
      sessionId: string;
      reason?: "created" | "updated";
    };

type PlatformEventInput =
  | Omit<Extract<PlatformEvent, { type: "agent_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "mcp_instance" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "mcp_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "platform_service_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "runner_node" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "agent_fs_changed" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "cloud_session_changed" }>, "ts">;

type Listener = (event: PlatformEvent) => void;

class PlatformEventBus {
  /** tenantId → listeners */
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(tenantId: string, listener: Listener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) {
      set = new Set();
      this.listeners.set(tenantId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(tenantId);
    };
  }

  publish(tenantId: string, event: PlatformEventInput): void {
    const set = this.listeners.get(tenantId);
    if (!set || set.size === 0) return;
    const full = { ...event, ts: Date.now() } as PlatformEvent;
    for (const fn of set) {
      try {
        fn(full);
      } catch (err) {
        console.warn("[platform-events] listener error:", err);
      }
    }
  }

  /** Broadcast to every subscribed tenant (host-level services). */
  publishAll(event: PlatformEventInput): void {
    const full = { ...event, ts: Date.now() } as PlatformEvent;
    for (const set of this.listeners.values()) {
      for (const fn of set) {
        try {
          fn(full);
        } catch (err) {
          console.warn("[platform-events] listener error:", err);
        }
      }
    }
  }

  /** 当前租户是否有订阅者（发布方可据此跳过昂贵的负载构造） */
  hasListeners(tenantId: string): boolean {
    return (this.listeners.get(tenantId)?.size ?? 0) > 0;
  }
}

export const platformEvents = new PlatformEventBus();
