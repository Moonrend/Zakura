/**
 * Go 代理拨入的 WSS Hub。控制面只通过这里碰远端主机 / Docker。
 */
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { hashRunnerToken, isRunnerToken } from "@zakura/core";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runtimeNodes } from "../db/schema.js";
import { log } from "@zakura/core";
import { cacheRunnerToken } from "./runtime-nodes.js";
import { platformEvents } from "./platform-events.js";
import { isLocalRuntimeNode } from "./runner-access.js";

type Frame = {
  type: string;
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
  stream?: string;
  chan?: string;
  data?: string;
};

export class HubSession {
  readonly nodeId: string;
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  storageRoot = "";
  version = "";
  kind = "";
  lastHello: Record<string, unknown> = {};
  ready = false;
  lastSeenAt = Date.now();
  private readonly streams = new Map<string, (chan: string, data: Buffer) => void>();

  constructor(nodeId: string, ws: WebSocket, private readonly onPong?: () => void) {
    this.nodeId = nodeId;
    this.ws = ws;
  }

  get connected(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  onStream(id: string, fn: (chan: string, data: Buffer) => void): () => void {
    this.streams.set(id, fn);
    return () => this.streams.delete(id);
  }

  handle(raw: RawData) {
    let msg: Frame;
    try {
      msg = JSON.parse(String(raw)) as Frame;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const p = (msg.params ?? {}) as { version?: string; kind?: string };
      this.version = p.version ?? this.version;
      this.kind = p.kind ?? this.kind;
      return;
    }
    if (msg.type === "pong") {
      this.lastSeenAt = Date.now();
      this.onPong?.();
      return;
    }
    if (msg.type === "stream" && msg.stream) {
      this.lastSeenAt = Date.now();
      const fn = this.streams.get(msg.stream);
      const buf = msg.data ? Buffer.from(msg.data, "base64") : Buffer.alloc(0);
      fn?.(msg.chan ?? "stdout", buf);
      return;
    }
    if (msg.type === "res" && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.lastSeenAt = Date.now();
      this.pending.delete(msg.id);
      if (msg.ok === false) p.reject(new Error(msg.error || "agent error"));
      else p.resolve(msg.result);
      return;
    }
  }

  rpc<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new Error("代理未连接"));
    }
    const id = String(++this.seq);
    const frame: Frame = { type: "req", id, method, params: params ?? {} };
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      const fail = (error: Error) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      };
      try {
        this.ws.send(JSON.stringify(frame), (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(reason?: string, terminate = false) {
    this.ready = false;
    for (const [, p] of this.pending) p.reject(new Error(reason || "连接关闭"));
    this.pending.clear();
    this.streams.clear();
    try {
      if (terminate) this.ws.terminate();
      else this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class RunnerHub {
  private readonly sessions = new Map<string, HubSession>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly db: Db,
    private readonly options: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number } = {},
  ) {}

  attach(server: HttpServer) {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      if (!url.startsWith("/api/runtime-nodes/hub")) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.accept(ws, req).catch((error: unknown) => {
          log.warn("runner_hub.accept_failed", { err: String(error) });
          ws.terminate();
        });
      });
    });
  }

  get(nodeId: string): HubSession | null {
    const session = this.sessions.get(nodeId);
    if (!session?.ready || !session.connected) return null;
    if (Date.now() - session.lastSeenAt > (this.options.heartbeatTimeoutMs ?? 60_000)) return null;
    return session;
  }

  require(nodeId: string): HubSession {
    const s = this.get(nodeId);
    if (!s) throw new Error("该节点的 Go 代理未在线。请在设备上安装并启动 zakura-agent。");
    return s;
  }

  disconnect(nodeId: string): void {
    const session = this.sessions.get(nodeId);
    this.sessions.delete(nodeId);
    session?.close("运行节点已删除", true);
  }

  private async accept(ws: WebSocket, req: IncomingMessage) {
    ws.on("error", () => ws.terminate());
    const token = bearer(req);
    if (!token || !isRunnerToken(token)) {
      ws.close(4401, "token");
      return;
    }
    const hash = hashRunnerToken(token);
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.tokenHash, hash),
    });
    if (!node || isLocalRuntimeNode(node)) {
      ws.close(4403, "unknown token");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    cacheRunnerToken(node.id, token);
    const prev = this.sessions.get(node.id);
    prev?.close("replaced");
    const session = new HubSession(node.id, ws, () => {
      if (session.ready && this.sessions.get(node.id) === session) {
        void this.mark(node.id, "online");
      }
    });
    this.sessions.set(node.id, session);

    ws.on("message", (data) => session.handle(data));
    ws.on("close", () => {
      session.close("连接关闭");
      if (this.sessions.get(node.id) === session) {
        this.sessions.delete(node.id);
        void this.mark(node.id, "offline", true);
      }
    });
    ws.send(JSON.stringify({ type: "welcome", id: node.id }));
    try {
      const info = await session.rpc<{
        version?: string;
        storageRoot?: string;
        kind?: string;
        hostInfo?: unknown;
        capabilities?: unknown;
        docker?: { ok?: boolean; version?: string };
      }>("sys.info", {}, 30_000);
      if (this.sessions.get(node.id) !== session || !session.connected) return;
      session.storageRoot = info.storageRoot ?? "";
      session.version = info.version ?? "";
      session.kind = info.kind ?? node.kind;
      const now = new Date();
      const [updated] = await this.db
        .update(runtimeNodes)
        .set({
          status: sql`case when ${runtimeNodes.status} = 'draining' then 'draining' else 'online' end`,
          // A reinstalled legacy runner keeps its token and bindings, and joins
          // the Go node pool as the kind reported by the new agent.
          kind: node.kind === "runner" && (info.kind === "computer" || info.kind === "server")
            ? info.kind : node.kind,
          endpoint: null,
          hostInfoJson: JSON.stringify(info.hostInfo ?? {}),
          capabilitiesJson: JSON.stringify(info.capabilities ?? { host: true }),
          agentVersion: info.version ?? node.agentVersion,
          storageRoot: info.storageRoot || node.storageRoot,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(runtimeNodes.id, node.id))
        .returning();
      if (!updated) {
        session.close("运行节点已删除", true);
        return;
      }
      if (this.sessions.get(node.id) !== session || !session.connected) return;
      session.ready = true;
      const event = { type: "runner_node" as const, nodeId: node.id };
      if (node.isShared) platformEvents.publishAll(event);
      else platformEvents.publish(node.tenantId, event);
      log.info("runner_hub.online", { node_id: node.id, version: info.version });
    } catch (err) {
      log.warn("runner_hub.hello_failed", {
        node_id: node.id,
        err: err instanceof Error ? err.message : String(err),
      });
      session.close("代理握手失败", true);
      return;
    }

    const beat = setInterval(() => {
      if (this.sessions.get(node.id) !== session || !session.connected) {
        clearInterval(beat);
        return;
      }
      if (!this.get(node.id)) {
        session.close("代理心跳超时", true);
        clearInterval(beat);
        return;
      }
      ws.send(JSON.stringify({ type: "ping", id: "beat" }));
    }, this.options.heartbeatIntervalMs ?? Math.min(20_000, (this.options.heartbeatTimeoutMs ?? 60_000) / 3));
    beat.unref();
    ws.on("close", () => clearInterval(beat));
  }

  private async mark(nodeId: string, status: "online" | "offline", publish = false) {
    const now = new Date();
    try {
      const [node] = await this.db
        .update(runtimeNodes)
        .set({
          status: sql`case when ${runtimeNodes.status} = 'draining' then 'draining' else ${status} end`,
          lastSeenAt: status === "online" ? now : undefined,
          updatedAt: now,
        })
        .where(eq(runtimeNodes.id, nodeId))
        .returning();
      if (publish && node) {
        const event = { type: "runner_node" as const, nodeId };
        if (node.isShared) platformEvents.publishAll(event);
        else platformEvents.publish(node.tenantId, event);
      }
    } catch (error) {
      log.warn("runner_hub.status_failed", { node_id: nodeId, err: String(error) });
    }
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  try {
    const u = new URL(req.url ?? "", "http://localhost");
    const q = u.searchParams.get("token");
    return q;
  } catch {
    return null;
  }
}
