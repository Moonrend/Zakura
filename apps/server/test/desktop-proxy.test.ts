import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, type TestContext } from "node:test";
import WebSocket from "ws";
import { createDesktopProxyGateway } from "../src/services/desktop-proxy.js";
import { signWorkspaceConnectionTicket } from "../src/services/desktop-ticket.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function bridge() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let killed = 0;
  const received: Buffer[] = [];
  const data = {
    readable: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    writable: new WritableStream<Uint8Array>({ write(chunk) { received.push(Buffer.from(chunk)); } }),
    onStderr: () => () => undefined,
    kill: async () => { killed++; },
  };
  return { data, received, send: (chunk: Uint8Array) => controller.enqueue(chunk), end: () => controller.close(), killed: () => killed };
}

async function fixture(t: TestContext, startStdio: () => Promise<ReturnType<typeof bridge>["data"]>) {
  const server = createServer();
  const clients: WebSocket[] = [];
  let readyChecks = 0;
  createDesktopProxyGateway(server, {
    config: { secret: "desktop-proxy-test" } as never,
    agentService: {
      get: async (tenantId: string, agentId: string) => tenantId === "t" && agentId === "a" ? { id: "a", enableComputer: true } : null,
      workspace: { ensureStarted: async () => { readyChecks++; }, startStdio },
    } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of clients) client.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    readyChecks: () => readyChecks,
    connect: (token = signWorkspaceConnectionTicket("desktop-proxy-test", "t", "a", "desktop")) => {
      const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/agents/a/desktop-proxy?token=${encodeURIComponent(token)}`);
      clients.push(ws);
      return ws;
    },
  };
}

describe("desktop proxy", { timeout: 5000 }, () => {
  it("relays binary desktop traffic and cleans up on disconnect", async (t) => {
    const stream = bridge();
    const app = await fixture(t, async () => stream.data);
    const ws = app.connect();
    await once(ws, "open");
    assert.equal(app.readyChecks(), 1);
    const payload = Buffer.from([0, 255, 128, 13, 10]);
    const output = once(ws, "message");
    stream.send(payload);
    assert.deepEqual((await output)[0], payload);
    ws.send(payload);
    const closed = once(ws, "close");
    ws.close();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Buffer.concat(stream.received), payload);
    assert.equal(stream.killed(), 1);
  });

  it("queues input arriving before Runner startup completes", async (t) => {
    const stream = bridge();
    const pending = deferred<typeof stream.data>();
    const starting = deferred<void>();
    const app = await fixture(t, () => { starting.resolve(); return pending.promise; });
    const ws = app.connect();
    await once(ws, "open");
    await starting.promise;
    ws.send("early input");
    await new Promise((resolve) => setTimeout(resolve, 10));
    pending.resolve(stream.data);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(Buffer.concat(stream.received).toString(), "early input");
  });

  it("kills a bridge created after noVNC already disconnected", async (t) => {
    const stream = bridge();
    const pending = deferred<typeof stream.data>();
    const starting = deferred<void>();
    const app = await fixture(t, () => { starting.resolve(); return pending.promise; });
    const ws = app.connect();
    await once(ws, "open");
    await starting.promise;
    ws.close();
    await once(ws, "close");
    pending.resolve(stream.data);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stream.killed(), 1);
  });

  it("reports upstream EOF as an error instead of a clean successful disconnect", async (t) => {
    const stream = bridge();
    const app = await fixture(t, async () => stream.data);
    const ws = app.connect();
    await once(ws, "open");
    const closed = once(ws, "close");
    stream.end();
    assert.equal((await closed)[0], 1011);
    assert.equal(stream.killed(), 1);
  });

  it("rejects tickets for a different tenant or connection kind", async (t) => {
    let starts = 0;
    const app = await fixture(t, async () => { starts++; return bridge().data; });
    for (const token of [
      signWorkspaceConnectionTicket("desktop-proxy-test", "another-tenant", "a", "desktop"),
      signWorkspaceConnectionTicket("desktop-proxy-test", "t", "a", "terminal"),
    ]) {
      const ws = app.connect(token);
      await once(ws, "error");
    }
    assert.equal(starts, 0);
  });
});
