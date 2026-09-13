/**
 * Go 代理拨入的 WSS Hub。控制面只通过这里碰远端主机 / Docker。
 */
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { hashRunnerToken, isRunnerToken } from "@zakura/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runtimeNodes } from "../db/schema.js";
import { log } from "@zakura/core";
import { cacheRunnerToken } from "./runtime-nodes.js";

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
  private readonly streams = new Map<string, (chan: string, data: Buffer) => void>();

  constructor(nodeId: string, ws: WebSocket) {
    this.nodeId = nodeId;
    this.ws = ws;
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
    if (msg.type === "pong") return;
    if (msg.type === "stream" && msg.stream) {
      const fn = this.streams.get(msg.stream);
      const buf = msg.data ? Buffer.from(msg.data, "base64") : Buffer.alloc(0);
      fn?.(msg.chan ?? "stdout", buf);
      return;
    }
    if (msg.type === "res" && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
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
      this.ws.send(JSON.stringify(frame));
    });
  }

  close(reason?: string) {
    for (const [, p] of this.pending) p.reject(new Error(reason || "连接关闭"));
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class RunnerHub {
  private readonly sessions = new Map<string, HubSession>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly db: Db) {}

  attach(server: HttpServer) {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      if (!url.startsWith("/api/runtime-nodes/hub")) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.accept(ws, req);
      });
    });
  }

  get(nodeId: string): HubSession | null {
    return this.sessions.get(nodeId) ?? null;
  }

  require(nodeId: string): HubSession {
    const s = this.sessions.get(nodeId);
    if (!s) throw new Error("该节点的 Go 代理未在线。请在设备上安装并启动 zakura-agent。");
    return s;
  }

  private async accept(ws: WebSocket, req: IncomingMessage) {
    const token = bearer(req);
    if (!token || !isRunnerToken(token)) {
      ws.close(4401, "token");
      return;
    }
    const hash = hashRunnerToken(token);
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.tokenHash, hash),
    });
    if (!node) {
      ws.close(4403, "unknown token");
      return;
    }
    cacheRunnerToken(node.id, token);
    const prev = this.sessions.get(node.id);
    prev?.close("replaced");
    const session = new HubSession(node.id, ws);
    this.sessions.set(node.id, session);

    ws.on("message", (data) => session.handle(data));
    ws.on("close", () => {
      if (this.sessions.get(node.id) === session) {
        this.sessions.delete(node.id);
        void this.mark(node.id, "offline");
      }
    });
    ws.on("error", () => {
      session.close("ws error");
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
      }>("sys.info");
      session.storageRoot = info.storageRoot ?? "";
      session.version = info.version ?? "";
      session.kind = info.kind ?? node.kind;
      const now = new Date();
      await this.db
        .update(runtimeNodes)
        .set({
          status: "online",
          endpoint: null,
          hostInfoJson: JSON.stringify(info.hostInfo ?? {}),
          capabilitiesJson: JSON.stringify(info.capabilities ?? { host: true }),
          agentVersion: info.version ?? node.agentVersion,
          storageRoot: info.storageRoot || node.storageRoot,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(runtimeNodes.id, node.id));
      log.info("runner_hub.online", { node_id: node.id, version: info.version });
    } catch (err) {
      log.warn("runner_hub.hello_failed", {
        node_id: node.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const beat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(beat);
        return;
      }
      ws.send(JSON.stringify({ type: "ping", id: "beat" }));
      void this.mark(node.id, "online");
    }, 20_000);
    ws.on("close", () => clearInterval(beat));
  }

  private async mark(nodeId: string, status: "online" | "offline") {
    const now = new Date();
    await this.db
      .update(runtimeNodes)
      .set({
        status,
        lastSeenAt: status === "online" ? now : undefined,
        updatedAt: now,
      })
      .where(eq(runtimeNodes.id, nodeId));
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
