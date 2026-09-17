import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { recordPlatformFault } from "@zakura/core";
import { WebSocket, WebSocketServer } from "ws";
import { ZakurabotAccessError, ZakurabotChannel, ZakurabotInputError, zakurabotThreadId, type ZakurabotIdentity } from "./zakurabot-channel.js";
import { channelIdSchema, ZAKURABOT_MAX_FRAME_BYTES, ZAKURABOT_PROTOCOL,
  zakurabotClientFrameSchema, type ZakurabotClientFrame, type ZakurabotServerFrame } from "./zakurabot-protocol.js";

type Connection = {
  ws: WebSocket;
  phase: "hello" | "authenticating" | "ready" | "closed";
  identity?: ZakurabotIdentity;
  allowed: Set<string>;
  rosterJson: string;
  alive: boolean;
  queued: number;
  queue: Promise<void>;
  unsubscribe?: () => void;
  helloTimer: ReturnType<typeof setTimeout>;
  refreshing?: Promise<void>;
};

/** Raw WS, sharing the HTTP server with Socket.IO, runner hub and desktop proxies. */
export class ZakurabotGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: ZAKURABOT_MAX_FRAME_BYTES });
  private readonly connections = new Set<Connection>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private detach?: () => void;
  private closing?: Promise<void>;

  constructor(readonly channel: ZakurabotChannel, private readonly options: {
    publicBaseUrl: string;
    helloTimeoutMs?: number;
    heartbeatMs?: number;
  }) {}

  attach(server: Server) {
    if (this.detach || this.closing) throw new Error("Zakura Bot gateway is already attached or closed");
    const prefix = new URL(this.options.publicBaseUrl).pathname.replace(/\/+$/, "");
    const paths = new Set(["/api/zakurabot/ws", `${prefix}/api/zakurabot/ws`]);
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const rawPath = request.url ?? "/";
      if (!rawPath.startsWith("/")) return;
      // The v1 client at 786d427 produces //api/... for a root Base URL.
      // Parse this as an origin-form path, never as a scheme-relative hostname.
      let url: URL;
      try { url = new URL(rawPath.replace(/^\/{2,}/, "/"), "http://localhost"); }
      catch { socket.destroy(); return; }
      if (!paths.has(url.pathname)) return;
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, Boolean(url.search)));
    };
    const onClose = () => { void this.close(); };
    server.on("upgrade", upgrade);
    server.on("close", onClose);
    this.detach = () => { server.off("upgrade", upgrade); server.off("close", onClose); };
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections) {
        if (connection.phase !== "ready") continue;
        if (!connection.alive) { connection.ws.terminate(); continue; }
        connection.alive = false;
        connection.ws.ping();
        void this.refreshConnection(connection);
      }
    }, this.options.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
  }

  private write(connection: Connection, frame: ZakurabotServerFrame): Promise<void> {
    const data = JSON.stringify(frame);
    if (connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Socket is closed"));
    if (Buffer.byteLength(data) > ZAKURABOT_MAX_FRAME_BYTES || connection.ws.bufferedAmount > 2 * ZAKURABOT_MAX_FRAME_BYTES) {
      connection.ws.close(1013, "Channel output buffer full; reconnect");
      return Promise.reject(new Error("Channel output buffer full"));
    }
    return new Promise((resolve, reject) => connection.ws.send(data, (error) => error ? reject(error) : resolve()));
  }

  /**
   * Close codes the v1 client treats as terminal: 1008, 4401 and 4403. Everything else
   * (including 1012 for credential rotation and 4408 for a slow hello) lets it reconnect.
   */
  private async fail(connection: Connection, message: string, code: number,
    correlation?: { agentId: string; clientMessageId?: string }) {
    connection.phase = "closed";
    clearTimeout(connection.helloTimer);
    connection.unsubscribe?.();
    await this.write(connection, { type: "error", message, ...correlation,
      fatal: [1008, 4401, 4403].includes(code) }).catch(() => undefined);
    connection.ws.close(code, message.slice(0, 100));
  }

  private accept(ws: WebSocket, hasQuery: boolean) {
    const connection: Connection = {
      ws, phase: "hello", allowed: new Set(), rosterJson: "", alive: true, queued: 0, queue: Promise.resolve(),
      // A client may still be refreshing its access token; let it retry rather than reporting bad credentials.
      helloTimer: setTimeout(() => { void this.fail(connection, "Timed out waiting for hello; reconnect and authenticate", 4408); },
        this.options.helloTimeoutMs ?? 5000),
    };
    connection.helloTimer.unref();
    this.connections.add(connection);
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      connection.phase = "closed";
      clearTimeout(connection.helloTimer);
      connection.unsubscribe?.();
      this.connections.delete(connection);
    });
    ws.on("pong", () => { connection.alive = true; });
    ws.on("message", (raw, binary) => {
      if (connection.phase === "closed") return;
      connection.alive = true;
      if (binary) { void this.fail(connection, "Expected a JSON text frame", 1008); return; }
      let value: unknown;
      try { value = JSON.parse(raw.toString()); }
      catch { void this.fail(connection, "Malformed channel JSON", 1008); return; }
      const parsed = zakurabotClientFrameSchema.safeParse(value);
      if (!parsed.success) {
        const input = value as { type?: unknown; agentId?: unknown; clientMessageId?: unknown } | null;
        if (connection.phase === "ready" && input?.type === "send" &&
          channelIdSchema.safeParse(input.agentId).success && channelIdSchema.safeParse(input.clientMessageId).success) {
          void this.write(connection, { type: "error", message: "Use 1–4000 characters per message",
            agentId: input.agentId as string, clientMessageId: input.clientMessageId as string }).catch(() => undefined);
        } else void this.fail(connection, "Invalid channel frame or unsupported protocol", 1008);
        return;
      }
      const frame = parsed.data;
      if (connection.phase === "hello") {
        if (frame.type !== "hello") { void this.fail(connection, "Authenticate with hello first", 4401); return; }
        connection.phase = "authenticating";
        void this.authenticate(connection, frame.token);
        return;
      }
      if (connection.phase !== "ready" || frame.type === "hello") {
        void this.fail(connection, "Wait for ready before sending channel data", 1008);
        return;
      }
      if (frame.type === "ping") {
        void this.refreshConnection(connection).then(() => {
          if (connection.phase === "ready") return this.write(connection, { type: "pong" });
        }).catch(() => undefined);
        return;
      }
      if (connection.queued >= 16) {
        void this.requestError(connection, frame, new ZakurabotInputError("Too many pending messages; try again shortly"));
        return;
      }
      connection.queued += 1;
      connection.queue = connection.queue.then(async () => {
        if (connection.phase !== "ready") return;
        if (frame.type === "send") await this.channel.send(connection.identity!, frame);
        else await this.channel.interrupt(connection.identity!, frame.agentId);
      }).catch((error) => this.requestError(connection, frame, error))
        .finally(() => { connection.queued -= 1; });
    });
    if (hasQuery) void this.fail(connection, "Credentials must be sent in hello, never the URL", 1008);
  }

  private async authenticate(connection: Connection, token: string) {
    try {
      const device = await this.channel.deps.store.authenticate(token);
      if (!device) throw new ZakurabotAccessError("Device token is invalid, expired, or revoked", 4401);
      const roster = await this.channel.roster(device);
      if (connection.phase !== "authenticating" || connection.ws.readyState !== WebSocket.OPEN) return;
      connection.identity = { id: device.id, tenantId: device.tenantId };
      connection.allowed = new Set(roster.conversations.map(zakurabotThreadId));
      connection.rosterJson = JSON.stringify(roster.agents);
      await this.write(connection, { type: "ready", protocol: ZAKURABOT_PROTOCOL, agents: roster.agents,
        capabilities: this.channel.capabilities() });
      if (connection.phase !== "authenticating" || connection.ws.readyState !== WebSocket.OPEN) return;
      connection.phase = "ready";
      clearTimeout(connection.helloTimer);
      connection.unsubscribe = this.channel.subscribe(device, async (c, frame) => {
        if (connection.phase === "ready" && connection.allowed.has(zakurabotThreadId(c))) {
          await this.write(connection, frame);
        }
      });
      for (const c of roster.conversations) {
        const messages = await this.channel.history(c);
        for (const frame of messages) {
          if (connection.phase !== "ready") return;
          await this.write(connection, frame);
        }
      }
    } catch (error) {
      await this.connectionError(connection, error);
    }
  }

  private async connectionError(connection: Connection, error: unknown) {
    if (connection.phase === "closed") return;
    if (error instanceof ZakurabotAccessError) await this.fail(connection, error.message, error.closeCode);
    else {
      recordPlatformFault("zakurabot.socket", error, { subsystem: "remote_agent" });
      await this.fail(connection, "Zakura Bot is temporarily unavailable", 1011);
    }
  }

  private async requestError(connection: Connection, frame: Extract<ZakurabotClientFrame, { type: "send" | "interrupt" }>, error: unknown) {
    if (error instanceof ZakurabotAccessError && error.closeCode === 4401) {
      await this.fail(connection, error.message, error.closeCode,
        { agentId: frame.agentId, ...(frame.type === "send" ? { clientMessageId: frame.clientMessageId } : {}) });
      return;
    }
    if (!(error instanceof ZakurabotAccessError) && !(error instanceof ZakurabotInputError)) {
      recordPlatformFault("zakurabot.inbound", error, { subsystem: "remote_agent" });
    }
    await this.write(connection, { type: "error", agentId: frame.agentId,
      ...(frame.type === "send" ? { clientMessageId: frame.clientMessageId } : {}),
      message: error instanceof ZakurabotAccessError || error instanceof ZakurabotInputError
        ? error.message : "Message could not be processed; check the binding and retry",
    }).catch(() => undefined);
  }

  private refreshConnection(connection: Connection): Promise<void> {
    if (connection.phase !== "ready") return Promise.resolve();
    if (connection.refreshing) return connection.refreshing;
    connection.refreshing = (async () => {
      const roster = await this.channel.roster(connection.identity!);
      if (connection.phase !== "ready") return;
      connection.allowed = new Set(roster.conversations.map(zakurabotThreadId));
      const next = JSON.stringify(roster.agents);
      if (next !== connection.rosterJson) {
        connection.rosterJson = next;
        await this.write(connection, { type: "agents", agents: roster.agents });
      }
    })().catch((error) => this.connectionError(connection, error))
      .finally(() => { connection.refreshing = undefined; });
    return connection.refreshing;
  }

  /** Called after binding/ACL edits; outbound authorization also reads current DB state. */
  async refresh() {
    await Promise.all(Array.from(this.connections, (connection) => this.refreshConnection(connection)));
    await this.channel.revalidateRuns();
  }

  async disconnectDevice(tenantId: string, deviceId: string, message = "Device token has been revoked", code: 4401 | 1012 = 4401) {
    await Promise.all(Array.from(this.connections).filter((c) => c.identity?.tenantId === tenantId && c.identity.id === deviceId)
      .map((c) => this.fail(c, message, code)));
    await this.channel.revalidateRuns();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.detach?.();
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const connection of this.connections) {
        connection.phase = "closed";
        clearTimeout(connection.helloTimer);
        connection.unsubscribe?.();
        connection.ws.terminate();
      }
      await this.channel.stop();
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    })();
    return this.closing;
  }
}
