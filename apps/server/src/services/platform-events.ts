/**
 * 平台事件总线：租户级 pub/sub，经实时网关（Socket.IO room `tenant:<id>`）推给前端。
 * 用于把长任务进度（MCP 安装/启动、Agent 工作区拉起）与状态变化实时推给前端，
 * 取代前端轮询。事件是瞬态信号，不落库：断线重连后前端应重新拉一次快照接口对齐状态。
 *
 * 跨实例：经 Redis Pub/Sub 扇出（频道见 REDIS_KEYS.platformChannel），机制与
 * cloud-agent-session 一致 —— 信封带实例 ID 自过滤，订阅按租户引用计数。
 * REDIS_URL=off 或 Redis 不可用时自动降级为纯进程内投递。
 */
import { recordPlatformFault } from "@zakura/core";
import { newId } from "../db/schema.js";
import {
  createRedisSubscriber,
  getRedis,
  isRedisEnabled,
  REDIS_KEYS,
  type ZakuraRedis,
} from "./redis.js";
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
    }
  | {
      /** 连接器 / 远程通道入站（用于浏览器通知） */
      type: "connector_inbound";
      ts: number;
      agentId: string;
      sessionId: string;
      platform: string;
      title: string;
      preview?: string;
    }
  | {
      /** Agent 主动调用浏览器通知工具 */
      type: "browser_notify";
      ts: number;
      agentId: string;
      title: string;
      body?: string;
      url?: string;
    }
  | {
      /** 租户连接器/远程通道的用户可见提示（不要打 stdout） */
      type: "connector_notice";
      ts: number;
      agentId: string;
      bindingId?: string;
      platform: string;
      level: "info" | "warn" | "error" | "ok";
      message: string;
    };

type PlatformEventInput =
  | Omit<Extract<PlatformEvent, { type: "agent_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "mcp_instance" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "mcp_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "platform_service_progress" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "runner_node" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "agent_fs_changed" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "cloud_session_changed" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "connector_inbound" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "browser_notify" }>, "ts">
  | Omit<Extract<PlatformEvent, { type: "connector_notice" }>, "ts">;

type Listener = (event: PlatformEvent) => void;

/** 退订回调；订阅失败或已关闭时为 null */
type Unsub = (() => Promise<void>) | null;

type RedisFanoutMessage = {
  from: string;
  /** 事件本身不带租户，跨实例投递时必须随信封带上 */
  tenantId: string;
  event: PlatformEvent;
};

export class PlatformEventBus {
  /**
   * 区分本实例 PUBLISH，避免本地 emit + Redis 回环双推。
   * 按实例（而非模块）分配：生产环境每进程一个 bus，行为不变；
   * 同进程构造多个 bus（测试模拟多副本）时也能正确互相投递。
   */
  private readonly instanceId = newId();
  /** tenantId → listeners */
  private readonly listeners = new Map<string, Set<Listener>>();
  /**
   * 跨实例 fan-out：按租户频道引用计数。
   * ready 存「订阅完成后得到的退订函数」的 promise —— 订阅是异步的，
   * 而退订可能先于它完成（快速切页），必须 await 后再退，否则订阅会泄漏。
   */
  private readonly remoteRef = new Map<string, { count: number; ready: Promise<Unsub> }>();
  /** host 级广播频道（publishAll）的引用计数 */
  private allRef = 0;
  private allReady: Promise<Unsub> | null = null;
  private subClient: ZakuraRedis | null = null;
  private subReady: Promise<ZakuraRedis | null> | null = null;
  private warnedPublish = false;
  private closed = false;

  private async ensureSubClient(): Promise<ZakuraRedis | null> {
    if (this.closed) return null;
    if (this.subClient?.isOpen) return this.subClient;
    if (!this.subReady) {
      this.subReady = createRedisSubscriber()
        .then((c) => {
          // close() 可能在建连期间发生：别把连接留下
          if (this.closed && c?.isOpen) {
            void c.quit().catch(() => {});
            return null;
          }
          this.subClient = c;
          return c;
        })
        .catch((err) => {
          recordPlatformFault("platform_events.subscriber", err, {
            subsystem: "platform_events",
            dep: "redis",
          });
          return null;
        });
    }
    return this.subReady;
  }

  /** 订阅一个频道，返回退订函数（失败或已关闭时返回 null） */
  private async subscribeChannel(
    channel: string,
    handler: (message: string) => void,
  ): Promise<Unsub> {
    const sub = await this.ensureSubClient();
    if (!sub || this.closed) return null;
    try {
      await sub.subscribe(channel, handler);
      return async () => {
        try {
          await sub.unsubscribe(channel);
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      recordPlatformFault("platform_events.subscribe", err, {
        subsystem: "platform_events",
        dep: "redis",
      });
      return null;
    }
  }

  /** 解析并本地投递来自其它实例的事件 */
  private onRemoteMessage = (message: string) => {
    try {
      const msg = JSON.parse(message) as RedisFanoutMessage;
      if (msg.from === this.instanceId) return;
      this.emitLocal(msg.tenantId, msg.event);
    } catch (err) {
      recordPlatformFault("platform_events.parse", err, {
        subsystem: "platform_events",
        dep: "redis",
      });
    }
  };

  /** 收到 host 级广播：投递给本实例所有租户的监听者 */
  private onRemoteAllMessage = (message: string) => {
    try {
      const msg = JSON.parse(message) as RedisFanoutMessage;
      if (msg.from === this.instanceId) return;
      this.emitLocalAll(msg.event);
    } catch (err) {
      recordPlatformFault("platform_events.broadcast_parse", err, {
        subsystem: "platform_events",
        dep: "redis",
      });
    }
  };

  private async ensureRemote(tenantId: string): Promise<void> {
    const existing = this.remoteRef.get(tenantId);
    if (existing) {
      existing.count += 1;
    } else {
      // 同步登记 ready promise，后续 release 可 await 它再退订
      const ready = this.subscribeChannel(
        REDIS_KEYS.platformChannel(tenantId),
        this.onRemoteMessage,
      );
      this.remoteRef.set(tenantId, { count: 1, ready });
      await ready;
    }

    // host 级广播频道：只要本实例有任何监听者就得订上
    this.allRef += 1;
    if (this.allRef === 1 && !this.allReady) {
      this.allReady = this.subscribeChannel(
        REDIS_KEYS.platformChannelAll,
        this.onRemoteAllMessage,
      );
      await this.allReady;
    }
  }

  private async releaseRemote(tenantId: string): Promise<void> {
    const entry = this.remoteRef.get(tenantId);
    if (entry) {
      entry.count -= 1;
      if (entry.count <= 0) {
        this.remoteRef.delete(tenantId);
        // 订阅可能还在建立中：必须等它完成才知道要退什么
        const unsub = await entry.ready;
        await unsub?.();
      }
    }

    this.allRef = Math.max(0, this.allRef - 1);
    if (this.allRef === 0 && this.allReady) {
      const ready = this.allReady;
      this.allReady = null;
      const unsub = await ready;
      await unsub?.();
    }
  }

  /** 发布到 Redis；失败只告警一次并降级为本实例内投递 */
  private publishRemote(channel: string, tenantId: string, event: PlatformEvent): void {
    if (!isRedisEnabled()) return;
    const msg: RedisFanoutMessage = { from: this.instanceId, tenantId, event };
    void getRedis()
      .then((redis) => redis?.publish(channel, JSON.stringify(msg)))
      .catch((err) => {
        if (this.warnedPublish) return;
        this.warnedPublish = true;
        recordPlatformFault("platform_events.publish", err, {
          subsystem: "platform_events",
          dep: "redis",
        });
      });
  }

  private emitLocal(tenantId: string, event: PlatformEvent): void {
    const set = this.listeners.get(tenantId);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (err) {
        recordPlatformFault("platform_events.listener", err, {
          subsystem: "platform_events",
        });
      }
    }
  }

  private emitLocalAll(event: PlatformEvent): void {
    for (const set of this.listeners.values()) {
      for (const fn of set) {
        try {
          fn(event);
        } catch (err) {
          recordPlatformFault("platform_events.listener", err, {
          subsystem: "platform_events",
        });
        }
      }
    }
  }

  subscribe(tenantId: string, listener: Listener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) {
      set = new Set();
      this.listeners.set(tenantId, set);
    }
    set.add(listener);
    void this.ensureRemote(tenantId);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(tenantId);
      void this.releaseRemote(tenantId);
    };
  }

  publish(tenantId: string, event: PlatformEventInput): void {
    const full = { ...event, ts: Date.now() } as PlatformEvent;
    // 本地先投递，再广播到其它实例。注意这里**不能**因本地无监听者就早退：
    // 产生事件的副本未必是浏览器连着的那个副本。
    this.emitLocal(tenantId, full);
    this.publishRemote(REDIS_KEYS.platformChannel(tenantId), tenantId, full);
  }

  /** Broadcast to every subscribed tenant (host-level services). */
  publishAll(event: PlatformEventInput): void {
    const full = { ...event, ts: Date.now() } as PlatformEvent;
    this.emitLocalAll(full);
    this.publishRemote(REDIS_KEYS.platformChannelAll, "*", full);
  }

  /**
   * 当前**本副本**是否有订阅者（发布方可据此跳过昂贵的负载构造）。
   * 多副本下这只是本地提示，不代表全局无人订阅。
   */
  hasListeners(tenantId: string): boolean {
    return (this.listeners.get(tenantId)?.size ?? 0) > 0;
  }

  /** 释放 Redis 订阅连接（进程退出 / 测试收尾） */
  async close(): Promise<void> {
    this.closed = true;
    // 等所有挂起的订阅落定，避免 close 之后又冒出一条连接
    const pending = [...this.remoteRef.values()].map((e) => e.ready);
    if (this.allReady) pending.push(this.allReady);
    this.remoteRef.clear();
    this.allRef = 0;
    this.allReady = null;
    for (const ready of pending) {
      const unsub = await ready.catch(() => null);
      await unsub?.().catch(() => {});
    }

    const client = await (this.subReady ?? Promise.resolve(this.subClient)).catch(() => null);
    this.subClient = null;
    this.subReady = null;
    if (client?.isOpen) {
      try {
        await client.quit();
      } catch {
        /* ignore */
      }
    }
  }
}

export const platformEvents = new PlatformEventBus();
