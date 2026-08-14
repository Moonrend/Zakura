import type { Server } from "node:http";
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
        else void bridgeTerminal(ws, agent);
      });
    }).catch(() => socket.destroy());
  });

  async function bridgeDesktop(
    ws: WebSocket,
    agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>,
  ) {
    let bridge: Awaited<ReturnType<AgentService["workspace"]["startStdio"]>> | undefined;
    try {
      bridge = await deps.agentService.workspace.startStdio(agent, ["socat", "-", "TCP:127.0.0.1:5900"], {
        workingDir: "/",
      });
      const writer = bridge.writable.getWriter();
      ws.on("message", (data, isBinary) => {
        if (isBinary || data instanceof Buffer) void writer.write(new Uint8Array(data as Buffer)).catch(() => undefined);
      });
      ws.on("close", () => {
        void writer.close().catch(() => undefined);
        void bridge?.kill();
      });
      const reader = bridge.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ws.readyState !== ws.OPEN) break;
        if (value?.byteLength) ws.send(Buffer.from(value));
      }
      if (ws.readyState === ws.OPEN) ws.close();
    } catch {
      if (ws.readyState === ws.OPEN) ws.close(1011, "desktop proxy unavailable");
      await bridge?.kill().catch(() => undefined);
    }
  }

  async function bridgeTerminal(
    ws: WebSocket,
    agent: NonNullable<Awaited<ReturnType<AgentService["get"]>>>,
  ) {
    let jobId: string | undefined;
    let outputCursor = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    let closed = false;
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
    try {
      const initial = await deps.agentService.workspace.startShellJob(
        agent,
        ["bash", "-l"],
        { onOutput: pushSnapshot },
      );
      jobId = initial.jobId;
      pushSnapshot(initial);
      send({ type: "ready", sessionId: jobId, command: "bash -l" });
      // Remote Runner callbacks cross an HTTP boundary, so keep a tight authoritative
      // snapshot stream as a fallback. Local PTY output is pushed immediately above.
      poll = setInterval(() => {
        if (!jobId || closed) return;
        void deps.agentService.workspace.getShellJob(agent, jobId).then(pushSnapshot).catch(() => undefined);
      }, 120);
      ws.on("message", (raw) => {
        if (!jobId) return;
        let message: { type?: string; data?: string; cols?: number; rows?: number };
        try {
          message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
        } catch {
          message = { type: "input", data: raw.toString() };
        }
        if (message.type === "input" && typeof message.data === "string") {
          // A one-millisecond wait still writes stdin for local PTY jobs; zero
          // intentionally short-circuits before the write path in ShellJob.
          void deps.agentService.workspace.waitShellJob(agent, jobId, 1, { stdin: message.data });
        } else if (message.type === "resize" && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
          void deps.agentService.workspace.resizeShellJob(agent, jobId, message.cols!, message.rows!);
        }
      });
      ws.on("close", () => {
        closed = true;
        if (poll) clearInterval(poll);
        if (jobId) void deps.agentService.workspace.killShellJob(agent, jobId).catch(() => undefined);
      });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      ws.close(1011, "terminal unavailable");
    }
  }
}
