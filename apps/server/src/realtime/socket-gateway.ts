/**
 * 实时网关：Socket.IO 单连接 + 多 room，替代原先两条手写 SSE。
 *
 * - 挂在 `/api/socket.io`（而非默认 `/socket.io`）：生产走 Caddy 的
 *   `handle /api/*` 转发到 API 服务；默认路径会落进 catch-all 被路由到 Next.js。
 * - 保留 polling 传输：本地开发经 Next rewrites 桥接，而 rewrites 不转发
 *   WebSocket upgrade，Socket.IO 会自动降级到 polling 继续工作。
 * - 跨实例扇出沿用既有设施：会话事件由 CloudAgentSessionStore 的 Redis
 *   pub/sub 负责，平台事件仍是进程内 bus（与迁移前一致）。
 */
import type { Server as HttpServer } from "node:http";
import { Server as SocketIoServer, type Socket } from "socket.io";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import type { CloudAgentSessionStore } from "../services/cloud-agent-session.js";
import type { CloudAgentEvent } from "@zakura/shared";
import { platformEvents, type PlatformEvent } from "../services/platform-events.js";
import { authenticateApiKey, verifySession } from "../services/auth.js";

/** 握手通过后挂在 socket 上的身份 */
type SocketSession = {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
};

type SubscribeSessionPayload = {
  agentId?: unknown;
  sessionId?: unknown;
  afterSeq?: unknown;
};

type SubscribeAck = (res: { ok: true; afterSeq: number } | { ok: false; error: string }) => void;

const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/** 网关实际用到的 store 能力面（收窄以便测试注入假实现） */
export type SocketGatewayStore = Pick<
  CloudAgentSessionStore,
  "getSession" | "listEvents" | "subscribe"
>;

export function createSocketGateway(
  httpServer: HttpServer,
  deps: { db: Db; config: AppConfig; store: SocketGatewayStore },
): SocketIoServer {
  const { db, config, store } = deps;

  const io = new SocketIoServer(httpServer, {
    path: "/api/socket.io",
    // 关闭尾斜杠：engine.io 默认把 path 规范化成 `/api/socket.io/` 再做前缀匹配，
    // 而 Next.js（trailingSlash: false）会把带尾斜杠的 URL 308 重定向掉，
    // 结果请求以 `/api/socket.io?EIO=4` 到达、匹配失败、落到 Hono 返回 401。
    // 两端必须一致关闭。
    addTrailingSlash: false,
    // websocket 优先；连不上（如 dev 经 Next rewrites）自动留在 polling
    transports: ["websocket", "polling"],
    // 与旧 SSE 的 CORS 策略一致：反射任意来源，鉴权走握手 token 而非 cookie
    cors: { origin: true, credentials: false },
    serveClient: false,
  });

  // —— 握手鉴权：token 走 auth 载荷，无需自定义头 ——
  io.use((socket, next) => {
    void (async () => {
      try {
        const raw = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        const token = typeof raw === "string" && raw ? raw : null;
        if (!token) return next(new Error("unauthorized"));

        const session = verifySession(config.secret, token);
        if (session) {
          socket.data.session = {
            userId: session.userId,
            tenantId: session.tenantId,
            email: session.email,
            role: session.role,
          } satisfies SocketSession;
          return next();
        }

        const keyed = await authenticateApiKey(db, token);
        if (keyed) {
          socket.data.session = {
            userId: "api-key",
            tenantId: keyed.tenant.id,
            email: keyed.apiKey.name,
            role: "api_key",
          } satisfies SocketSession;
          return next();
        }
        return next(new Error("unauthorized"));
      } catch (err) {
        // 兜底：任何异常都必须调用 next()，否则握手会一直挂到客户端超时
        console.warn("[realtime] handshake auth failed:", err);
        return next(new Error("unauthorized"));
      }
    })();
  });

  // —— 平台事件：每租户一个 bus 订阅，refcount 管理 ——
  const tenantSubs = new Map<string, { count: number; unsub: () => void }>();

  function retainTenant(tenantId: string) {
    const existing = tenantSubs.get(tenantId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const unsub = platformEvents.subscribe(tenantId, (ev: PlatformEvent) => {
      io.to(tenantRoom(tenantId)).emit("platform", ev);
    });
    tenantSubs.set(tenantId, { count: 1, unsub });
  }

  function releaseTenant(tenantId: string) {
    const entry = tenantSubs.get(tenantId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    tenantSubs.delete(tenantId);
    entry.unsub();
  }

  io.on("connection", (socket: Socket) => {
    const session = socket.data.session as SocketSession | undefined;
    if (!session) {
      socket.disconnect(true);
      return;
    }

    void socket.join(tenantRoom(session.tenantId));
    retainTenant(session.tenantId);

    /** sessionId → 取消 store 订阅 */
    const sessionSubs = new Map<string, () => void>();

    const dropSession = (sessionId: string) => {
      const unsub = sessionSubs.get(sessionId);
      if (!unsub) return;
      sessionSubs.delete(sessionId);
      unsub();
      void socket.leave(sessionRoom(sessionId));
    };

    socket.on("subscribe:session", (payload: SubscribeSessionPayload, ack?: SubscribeAck) => {
      void (async () => {
        const agentId = typeof payload?.agentId === "string" ? payload.agentId : "";
        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
        const afterRaw = Number(payload?.afterSeq ?? 0);
        let cursor = Number.isFinite(afterRaw) ? afterRaw : 0;

        if (!agentId || !sessionId) {
          ack?.({ ok: false, error: "agentId 与 sessionId 必填" });
          return;
        }
        // 重复订阅：先清掉旧的，避免同一 socket 上重复投递
        dropSession(sessionId);

        // 租户越权防护：只能订阅自己租户下该 agent 的会话
        const row = await store.getSession(session.tenantId, agentId, sessionId);
        if (!row) {
          ack?.({ ok: false, error: "Not found" });
          return;
        }

        // 先订阅并缓冲，再读 backlog —— 顺序颠倒会丢掉两者之间产生的事件
        // （旧 SSE 实现即是先读 backlog 后订阅，只能靠客户端定时重连补回）。
        let buffered: CloudAgentEvent[] | null = [];
        const deliver = (ev: CloudAgentEvent) => {
          if (ev.seq <= cursor) return;
          cursor = ev.seq;
          socket.emit("cloud", ev);
        };
        const unsub = store.subscribe(sessionId, (ev) => {
          if (buffered) buffered.push(ev);
          else deliver(ev);
        });
        sessionSubs.set(sessionId, unsub);
        void socket.join(sessionRoom(sessionId));

        try {
          const backlog = await store.listEvents(sessionId, { afterSeq: cursor });
          for (const ev of backlog) {
            if (ev.seq <= cursor) continue;
            cursor = ev.seq;
            socket.emit("cloud", ev);
          }
          // flush 缓冲后切换为直发
          const pending = buffered;
          buffered = null;
          for (const ev of pending) deliver(ev);
          ack?.({ ok: true, afterSeq: cursor });
        } catch (err) {
          dropSession(sessionId);
          ack?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    socket.on("unsubscribe:session", (payload: { sessionId?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      if (sessionId) dropSession(sessionId);
    });

    socket.on("disconnect", () => {
      for (const unsub of sessionSubs.values()) {
        try {
          unsub();
        } catch (err) {
          console.warn("[realtime] session unsubscribe failed:", err);
        }
      }
      sessionSubs.clear();
      releaseTenant(session.tenantId);
    });
  });

  return io;
}
