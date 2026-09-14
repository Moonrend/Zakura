import type { Server } from "node:http";
import { recordPlatformFault } from "@zakura/core";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyWorkspaceConnectionTicket } from "./desktop-ticket.js";
import type { AppConfig } from "../config.js";
import type { AgentService } from "./agents.js";

/** Browser desktop traffic is proxied through Zakura; the runner never gets a public VNC port. */
export function createDesktopProxyGateway(
  server: Server,
  deps: { config: AppConfig; agentService: AgentService },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/(desktop|terminal)-proxy$/);
    if (!match) return;
    const token = url.searchParams.get("token");
    const ticket = token ? verifyWorkspaceConnectionTicket(deps.config.secret, token) : null;
    const kind = match[2] as "desktop" | "terminal";
    if (!ticket || ticket.agentId !== match[1] || ticket.kind !== kind) {
      socket.destroy();
      return;
    }
    void deps.agentService.get(ticket.tenantId, match[1]).then((agent) => {
      if (!agent || !agent.enableComputer) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (kind === "desktop") void bridgeDesktop(ws, agent);
        else {
          ws.on("error", () => ws.close());
          void bridgeTerminal(ws, agent, ticket.adapterId);
        }
      });
    }).catch(() => socket.destroy());
  });

  async function bridgeDesktop(
    ws: WebSocket,
    agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>,
  ) {
    let bridge: Awaited<ReturnType<AgentService["workspace"]["startStdio"]>> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let unsubscribe: (() => void) | undefined;
    let stderr = "";
    let closed = false;
    let flushing = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      ws.resume();
      pending.length = 0;
      unsubscribe?.();
      void writer?.abort().catch(() => undefined);
      void reader?.cancel().catch(() => undefined);
      void bridge?.kill().catch(() => undefined);
    };
    const fail = (error: unknown) => {
      if (closed) return;
      recordPlatformFault("desktop.proxy", new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ""}`), { subsystem: "desktop" });
      if (ws.readyState === ws.OPEN) ws.close(1011, "Desktop unavailable; check workspace display/VNC logs");
      cleanup();
    };
    const flush = async () => {
      if (flushing || !writer || closed) return;
      flushing = true;
      try {
        while (pending.length && !closed) {
          const bytes = pending.shift()!;
          await writer.write(bytes);
          pendingBytes -= bytes.length;
        }
        if (!closed) ws.resume();
      } catch (error) { fail(error); }
      finally { flushing = false; }
    };
    // Attach lifecycle and input handlers before awaiting Runner startup.
    ws.on("close", cleanup);
    ws.on("error", fail);
    ws.on("message", (data) => {
      if (closed) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data)
        : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
      pendingBytes += bytes.length;
      if (pendingBytes > 1024 * 1024) {
        ws.close(1013, "Desktop input buffer full; reconnect");
        cleanup();
        return;
      }
      pending.push(bytes);
      if (pendingBytes > 64 * 1024) ws.pause();
      void flush();
    });
    try {
      await deps.agentService.workspace.ensureStarted(agent, { require: "display" });
      if (closed) return;
      bridge = await deps.agentService.workspace.startStdio(agent, ["socat", "STDIO", "TCP:127.0.0.1:5900,connect-timeout=5"], {
        workingDir: "/workspace",
      });
      if (closed) { await bridge.kill(); return; }
      unsubscribe = bridge.onStderr((chunk) => { stderr = (stderr + chunk).slice(-2000); });
      writer = bridge.writable.getWriter();
      reader = bridge.readable.getReader();
      void flush();
      while (!closed) {
        const { done, value } = await reader.read();
        if (closed) break;
        if (done) throw new Error("VNC stream ended unexpectedly");
        if (value?.byteLength && ws.readyState === ws.OPEN) {
          await new Promise<void>((resolve, reject) => ws.send(Buffer.from(value), (error) => error ? reject(error) : resolve()));
        }
      }
    } catch (error) { fail(error); }
    finally { cleanup(); }
  }

  async function bridgeTerminal(
    ws: WebSocket,
    agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>,
    adapterId?: string,
  ) {
    let jobId: string | undefined;
    let outputCursor = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let pendingSize: { cols: number; rows: number } | undefined;
    const send = (value: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
    };
    const pushSnapshot = (snap: Awaited<ReturnType<AgentService["workspace"]["getShellJob"]>>) => {
      const output = snap.terminalOutput ?? `${snap.stdout}${snap.stderr}`;
      const base = snap.terminalOffset ?? 0;
      // Raw PTY bytes are append-only. Do not derive terminal updates from the
      // folded screen snapshot: CR, cursor movement and erase sequences rewrite
      // earlier cells and make string-length diffs corrupt line boundaries.
      if (outputCursor < base) {
        send({ type: "reset" });
        outputCursor = base;
      }
      const localOffset = Math.max(0, outputCursor - base);
      const delta = output.slice(localOffset);
      outputCursor = base + output.length;
      if (delta) send({ type: "output", data: delta });
      if (!snap.running) {
        send({ type: "exit", code: snap.exitCode });
        ws.close(1000, "terminal exited");
      }
    };
    ws.on("message", (raw) => {
      let message: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
      } catch {
        message = { type: "input", data: raw.toString() };
      }
      if (message.type === "resize" && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        pendingSize = { cols: message.cols!, rows: message.rows! };
        if (jobId) void deps.agentService.workspace.resizeShellJob(agent, jobId, pendingSize.cols, pendingSize.rows);
      } else if (jobId && message.type === "input" && typeof message.data === "string") {
        void deps.agentService.workspace.waitShellJob(agent, jobId, 1, { stdin: message.data });
      }
    });
    ws.on("close", () => {
      closed = true;
      if (poll) clearInterval(poll);
      if (jobId) void deps.agentService.workspace.killShellJob(agent, jobId).catch(() => undefined);
    });
    try {
      // An ACP adapter now runs in its own container with its own credential
      // volume, so an interactive login must happen *there* — a shell in the
      // workspace container would write credentials the adapter never reads
      // (and in most images the adapter CLI is not even installed there).
      const initial = adapterId
        ? await deps.agentService.workspace.startAcpAdapterLoginShell(
            agent,
            adapterId,
            undefined,
            { onOutput: pushSnapshot },
          )
        : await deps.agentService.workspace.startShellJob(
            agent,
            ["bash", "-l"],
            { onOutput: pushSnapshot, interactive: true },
          );
      jobId = initial.jobId;
      if (closed) {
        await deps.agentService.workspace.killShellJob(agent, jobId).catch(() => undefined);
        return;
      }
      if (pendingSize) {
        await deps.agentService.workspace.resizeShellJob(agent, jobId, pendingSize.cols, pendingSize.rows);
      }
      pushSnapshot(initial);
      send({ type: "ready", sessionId: jobId, command: adapterId ? `${adapterId} login shell` : "bash -l" });
      // Remote Runner callbacks cross an HTTP boundary, so keep a tight authoritative
      // snapshot stream as a fallback. Local PTY output is pushed immediately above.
      poll = setInterval(() => {
        if (!jobId || closed) return;
        void deps.agentService.workspace.getShellJob(agent, jobId).then(pushSnapshot).catch(() => undefined);
      }, 120);
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      ws.close(1011, "terminal unavailable");
    }
  }
}
