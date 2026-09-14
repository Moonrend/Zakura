import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { openWorkspaceTcpTunnel } from "../src/services/workspace-tcp-tunnel.js";
import { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import type { Agent } from "../src/db/schema.js";

it("carries HTTP and binary WebSocket CDP traffic through the Runner stream, and closes all bridges", async (t) => {
  const http = createServer((_req, res) => res.end('{"Browser":"Chromium"}'));
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  let started = 0;
  let killed = 0;
  const streams: Array<ReturnType<typeof connect>> = [];
  const start = async () => {
    const socket = connect(port, "127.0.0.1");
    streams.push(socket);
    await once(socket, "connect");
    started++;
    const pair = Duplex.toWeb(socket);
    return { readable: pair.readable, writable: pair.writable, kill: async () => { killed++; socket.destroy(); } };
  };
  const tunnel = await openWorkspaceTcpTunnel(start as never);
  t.after(async () => {
    tunnel.close();
    for (const stream of streams) stream.destroy();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  assert.equal(tunnel.host, "127.0.0.1");
  assert.deepEqual(await (await fetch(`${tunnel.url}/json/version`)).json(), { Browser: "Chromium" });
  const ws = new WebSocket(tunnel.url.replace("http:", "ws:") + "/devtools/page/a");
  await once(ws, "open");
  const expected = Buffer.alloc(512 * 1024);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
  const message = once(ws, "message");
  ws.send(expected);
  assert.deepEqual((await message)[0], expected);
  const closed = once(ws, "close");
  tunnel.close();
  await closed;
  assert.equal(killed, started);
});

it("kills a bridge that finishes starting after its client has disconnected", async () => {
  let release: (value: any) => void = () => undefined;
  let started: () => void = () => undefined;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  let killed = 0;
  const tunnel = await openWorkspaceTcpTunnel(() => {
    started();
    return new Promise((resolve) => { release = resolve; });
  });
  try {
    const socket = connect(tunnel.port, tunnel.host);
    await once(socket, "connect");
    await starting;
    tunnel.close();
    const pair = new TransformStream<Uint8Array, Uint8Array>();
    release({ readable: pair.readable, writable: pair.writable, kill: async () => { killed++; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(killed, 1);
    socket.destroy();
  } finally { tunnel.close(); }
});

it("resolves CDP via authenticated stdio when public Runner ports are unreachable", async (t) => {
  const agent = { id: "a", tenantId: "t", runtimeNodeId: "n", enableComputer: true } as Agent;
  const commands: string[][] = [];
  const client = {
    getWorkspace: async () => ({ dockerId: "ctr", status: "running", endpoints: { cdpUrl: "http://127.0.0.1:65534" } }),
    execWorkspace: async () => ({ exitCode: 0, stdout: '{"Browser":"Chromium"}', stderr: "" }),
    startStdio: async (_id: string, command: string[]) => {
      commands.push(command);
      const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{"Browser":"Chromium"}');
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let sent = false;
      const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const writable = new WritableStream<Uint8Array>({ write() { if (!sent) { sent = true; controller.enqueue(response); controller.close(); } } });
      return { readable, writable, kill: async () => undefined };
    },
    stopWorkspace: async () => undefined,
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ dockerId: "ctr", status: "running" }] }) }),
    query: { agents: { findFirst: async () => agent } },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [agent] }) }) }),
  };
  const workspace = new AgentWorkspaceService(db as never, {} as never, {} as never, {
    requireRunnerClient: async () => ({ client, node: { id: "n", hostInfoJson: '{"primaryIp":"192.0.2.1"}' } }),
  } as never);
  t.after(() => workspace.stop(agent));
  const first = await workspace.resolveCdp(agent.id);
  assert.equal(first.reason, "ok");
  assert.match(first.url!, /^http:\/\/127\.0\.0\.1:/);
  assert.ok(commands.every((command) => command[0] === "socat" && command[2]?.startsWith("TCP:127.0.0.1:9222")));
  const second = await workspace.resolveCdp(agent.id);
  assert.equal(second.url, first.url);
});
