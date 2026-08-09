/**
 * 实时网关（Socket.IO）测试。
 *
 * 覆盖：Hono 路由共存、握手鉴权、租户越权防护、
 * backlog 竞态（订阅与回放之间产生的事件不丢）、断连清理不泄漏。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { CloudAgentEvent } from "@zakura/shared";
import { createSocketGateway, type SocketGatewayStore } from "../src/realtime/socket-gateway.js";
import { signSession } from "../src/services/auth.js";
import { closeRedis } from "../src/services/redis.js";

const SECRET = "test-secret";
const TENANT = "tenant-1";

function makeEvent(seq: number, sessionId = "s1"): CloudAgentEvent {
  return {
    id: `e${seq}`,
    sessionId,
    seq,
    type: "assistant_delta",
    runId: null,
    payload: { messageId: "m1", delta: `d${seq}` },
    createdAt: new Date().toISOString(),
  } as CloudAgentEvent;
}

/** 可编排的假 store：记录订阅/退订次数，可手动触发事件 */
function makeFakeStore(opts?: {
  sessionExists?: boolean;
  /** listEvents 被调用时触发的副作用（用于制造竞态） */
  onListEvents?: () => void;
  backlog?: CloudAgentEvent[];
}) {
  const listeners = new Map<string, (ev: CloudAgentEvent) => void>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;

  const store: SocketGatewayStore = {
    getSession: (async () =>
      opts?.sessionExists === false ? null : { id: "s1" }) as SocketGatewayStore["getSession"],
    listEvents: (async () => {
      opts?.onListEvents?.();
      return opts?.backlog ?? [];
    }) as SocketGatewayStore["listEvents"],
    subscribe: ((sessionId: string, listener: (ev: CloudAgentEvent) => void) => {
      subscribeCalls += 1;
      listeners.set(sessionId, listener);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(sessionId);
      };
    }) as SocketGatewayStore["subscribe"],
  };

  return {
    store,
    emit: (ev: CloudAgentEvent) => listeners.get(ev.sessionId)?.(ev),
    stats: () => ({ subscribeCalls, unsubscribeCalls, live: listeners.size }),
  };
}

type Harness = {
  url: string;
  close: () => Promise<void>;
};

async function startGateway(store: SocketGatewayStore, app?: Hono): Promise<Harness> {
  let server: HttpServer;
  if (app) {
    // serve() 的监听是异步的：必须等回调，否则 address() 仍为 null
    server = await new Promise<HttpServer>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(s as unknown as HttpServer),
      );
    });
  } else {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  }

  const gw = createSocketGateway(server, {
    db: {} as never,
    config: { secret: SECRET } as never,
    store,
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await gw.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function connect(url: string, token?: string): ClientSocket {
  return ioClient(url, {
    path: "/api/socket.io",
    transports: ["websocket"],
    reconnection: false,
    ...(token ? { auth: { token } } : {}),
  });
}

function validToken() {
  return signSession(SECRET, {
    userId: "u1",
    tenantId: TENANT,
    email: "a@b.c",
    role: "owner",
  });
}

const openSockets: ClientSocket[] = [];
const track = (s: ClientSocket) => {
  openSockets.push(s);
  return s;
};

after(async () => {
  for (const s of openSockets) s.close();
  // authenticateApiKey 会惰性建立 Redis 连接，不关会吊住整个测试进程
  await closeRedis();
});

describe("socket gateway", () => {
  it("不抢占 Hono 路由：非 /api/socket.io 请求照常处理", async () => {
    const app = new Hono();
    app.get("/api/health", (c) => c.json({ status: "ok" }));
    const fake = makeFakeStore();
    const h = await startGateway(fake.store, app);

    const res = await fetch(`${h.url}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });

    await h.close();
  });

  it("握手路径不带尾斜杠（防 Next.js 308 重定向回归）", async () => {
    // engine.io 默认把 path 规范化为 `/api/socket.io/` 再前缀匹配，
    // 而 Next.js(trailingSlash:false) 会把尾斜杠 308 掉，导致请求以
    // `/api/socket.io?EIO=4` 到达 → 匹配失败 → 落到 Hono 返回 401。
    // 这里直接断言服务端认无尾斜杠的形式。
    const app = new Hono();
    app.all("/api/*", (c) => c.json({ error: "Unauthorized" }, 401));
    const fake = makeFakeStore();
    const h = await startGateway(fake.store, app);

    const res = await fetch(`${h.url}/api/socket.io?EIO=4&transport=polling`);
    assert.equal(res.status, 200, "无尾斜杠的握手应由 socket.io 处理，而非落到 Hono");
    const body = await res.text();
    assert.match(body, /"sid"/, `期望 engine.io 握手响应，实际：${body.slice(0, 120)}`);

    await h.close();
  });

  it("无 token 的握手被拒", async () => {
    const fake = makeFakeStore();
    const h = await startGateway(fake.store);
    const c = track(connect(h.url));

    const err = await new Promise<Error>((resolve) => {
      c.on("connect_error", resolve);
      c.on("connect", () => resolve(new Error("unexpected connect")));
    });
    assert.equal(err.message, "unauthorized");
    // 中间件拒绝属终态，客户端不应自动重试
    assert.equal(c.active, false);

    c.close();
    await h.close();
  });

  it("坏 token 的握手被拒", async () => {
    const fake = makeFakeStore();
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, "not-a-real-token"));

    const err = await new Promise<Error>((resolve) => {
      c.on("connect_error", resolve);
      c.on("connect", () => resolve(new Error("unexpected connect")));
    });
    assert.equal(err.message, "unauthorized");

    c.close();
    await h.close();
  });

  it("越权订阅被拒，且不注册 store 订阅", async () => {
    const fake = makeFakeStore({ sessionExists: false });
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, validToken()));
    await new Promise<void>((r) => c.on("connect", () => r()));

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      c.emit("subscribe:session", { agentId: "a1", sessionId: "s1", afterSeq: 0 }, resolve);
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "Not found");
    // 关键：鉴权失败不得留下订阅
    assert.equal(fake.stats().subscribeCalls, 0);

    c.close();
    await h.close();
  });

  it("回放期间产生的事件不丢（backlog 竞态回归）", async () => {
    // listEvents 执行时触发一个 seq=2 的实时事件：
    // 旧实现「先回放后订阅」会永久丢掉它。
    const fake = makeFakeStore({
      backlog: [makeEvent(1)],
      onListEvents: () => queueMicrotask(() => fake.emit(makeEvent(2))),
    });
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, validToken()));
    await new Promise<void>((r) => c.on("connect", () => r()));

    const seen: number[] = [];
    c.on("cloud", (ev: CloudAgentEvent) => seen.push(ev.seq));

    await new Promise<void>((resolve) => {
      c.emit("subscribe:session", { agentId: "a1", sessionId: "s1", afterSeq: 0 }, () => resolve());
    });
    // 等竞态事件送达
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(seen, [1, 2], `期望收到 backlog 与竞态事件，实际 ${JSON.stringify(seen)}`);

    c.close();
    await h.close();
  });

  it("已回放过的 seq 不重复投递", async () => {
    const fake = makeFakeStore({ backlog: [makeEvent(5)] });
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, validToken()));
    await new Promise<void>((r) => c.on("connect", () => r()));

    const seen: number[] = [];
    c.on("cloud", (ev: CloudAgentEvent) => seen.push(ev.seq));

    const ack = await new Promise<{ ok: boolean; afterSeq?: number }>((resolve) => {
      c.emit("subscribe:session", { agentId: "a1", sessionId: "s1", afterSeq: 0 }, resolve);
    });
    assert.equal(ack.afterSeq, 5);

    fake.emit(makeEvent(5)); // 陈旧
    fake.emit(makeEvent(6)); // 新
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(seen, [5, 6]);

    c.close();
    await h.close();
  });

  it("断连时清理全部会话订阅，不泄漏", async () => {
    const fake = makeFakeStore();
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, validToken()));
    await new Promise<void>((r) => c.on("connect", () => r()));

    for (const sid of ["s1", "s2"]) {
      await new Promise<void>((resolve) => {
        c.emit("subscribe:session", { agentId: "a1", sessionId: sid, afterSeq: 0 }, () =>
          resolve(),
        );
      });
    }
    assert.equal(fake.stats().subscribeCalls, 2);
    assert.equal(fake.stats().live, 2);

    c.close();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(fake.stats().unsubscribeCalls, 2, "断连后两个订阅都应被退订");
    assert.equal(fake.stats().live, 0);

    await h.close();
  });

  it("重复订阅同一会话是幂等的（先清旧订阅）", async () => {
    const fake = makeFakeStore();
    const h = await startGateway(fake.store);
    const c = track(connect(h.url, validToken()));
    await new Promise<void>((r) => c.on("connect", () => r()));

    for (let i = 0; i < 2; i += 1) {
      await new Promise<void>((resolve) => {
        c.emit("subscribe:session", { agentId: "a1", sessionId: "s1", afterSeq: 0 }, () =>
          resolve(),
        );
      });
    }
    assert.equal(fake.stats().subscribeCalls, 2);
    assert.equal(fake.stats().unsubscribeCalls, 1, "第二次订阅应先退掉第一次");
    assert.equal(fake.stats().live, 1);

    const seen: number[] = [];
    c.on("cloud", (ev: CloudAgentEvent) => seen.push(ev.seq));
    fake.emit(makeEvent(1));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, [1], "不应重复投递");

    c.close();
    await h.close();
  });
});
