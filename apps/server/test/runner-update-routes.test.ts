import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import type { RunnerClient } from "@zakura/core";
import type { RunnerUpdateStatus } from "@zakura/shared";
import { registerRuntimeNodeRoutes } from "../src/api/runtime-node-routes.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { RuntimeNodeService } from "../src/services/runtime-nodes.js";

const target = { url: "https://download.example/agent", sha256: "ab".repeat(32), version: "new" };

function harness(client: Pick<RunnerClient, "updateRunner" | "systemVersion">) {
  const node = {
    id: "node", slug: "node", kind: "server", tokenHash: "token-hash", tenantId: "owner", isShared: true,
    hostInfoJson: JSON.stringify({ platform: "linux", arch: "amd64" }), agentVersion: "old",
  };
  const nodes = {
    async getAccessible(_tenantId: string, nodeId: string) { return nodeId === node.id ? node : null; },
    async requireRunnerClient(_tenantId: string, _nodeId: string, options: { skipHeartbeatRefresh?: boolean }) {
      assert.equal(options.skipHeartbeatRefresh, true);
      return { node, client };
    },
  };
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("session", { tenantId: c.req.header("x-tenant") ?? "owner", userId: "user" });
    await next();
  });
  registerRuntimeNodeRoutes(app, {
    nodes: nodes as unknown as RuntimeNodeService, db: {} as Db,
    config: { publicBaseUrl: "https://zakura.example", multiTenant: false } as AppConfig,
  });
  const post = (body: unknown = target, tenant = "owner") => app.request("/api/runtime-nodes/node/update-runner", {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify(body),
  });
  return { app, node, post };
}

test("HTTP update requests return 202 before download completion and expose the same background job", async () => {
  let release!: () => void;
  const download = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { app, post } = harness({
    async updateRunner(body, progress) {
      calls++;
      progress?.({ phase: "downloading", downloadedBytes: 50, totalBytes: 100 });
      await download;
      return { image: body.image, scheduled: true };
    },
    async systemVersion() { return { version: "new", image: "/agent", containerId: null, sha256: target.sha256 }; },
  });
  try {
    const response = await post();
    assert.equal(response.status, 202);
    const started = await response.json() as { update: RunnerUpdateStatus };
    const duplicate = await post();
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json() as typeof started).update.id, started.update.id);
    assert.equal(calls, 1);
    assert.equal((await post({ ...target, sha256: "cd".repeat(32) })).status, 409);
    const path = `/api/runtime-nodes/node/update-runner?id=${started.update.id}`;
    const progress = await app.request(path);
    assert.equal(progress.status, 200);
    assert.equal((await progress.json() as typeof started).update.downloadedBytes, 50);
    assert.equal((await app.request(`${path}-unknown`)).status, 404);
    assert.equal((await app.request(path, { headers: { "x-tenant": "consumer" } })).status, 403);
    release();
    const deadline = Date.now() + 2000;
    while (true) {
      const status = await (await app.request(path)).json() as typeof started;
      if (status.update.phase === "completed") break;
      assert.notEqual(status.update.phase, "failed");
      assert.ok(Date.now() < deadline, "job did not confirm the replacement agent");
      await delay(1);
    }
  } finally {
    release();
  }
});

test("invalid requests, unknown platforms and foreign shared-node users cannot start an update", async () => {
  let calls = 0;
  const { app, node, post } = harness({
    async updateRunner() { calls++; throw new Error("unexpected update"); },
    async systemVersion() { throw new Error("unexpected probe"); },
  });
  for (const body of [null, [], "string", { url: 42 }, { version: false }, { ...target, sha256: "abc" }]) {
    assert.equal((await post(body)).status, 400);
  }
  const malformed = await app.request("/api/runtime-nodes/node/update-runner", {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"url":',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await post(target, "consumer")).status, 403);
  for (const hostInfo of ["{}", "broken JSON", '{"platform":42,"arch":"amd64"}', '{"platform":"plan9","arch":"amd64"}']) {
    node.hostInfoJson = hostInfo;
    assert.equal((await post()).status, 400);
  }
  node.kind = "local";
  assert.equal((await post()).status, 400);
  assert.equal(calls, 0);
});

test("offline version probes return the last reported version", async () => {
  const { app } = harness({
    async updateRunner() { throw new Error("unused"); },
    async systemVersion() { throw new Error("代理未连接"); },
  });
  const response = await app.request("/api/runtime-nodes/node/version");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: "old", image: null, containerId: null, live: false, reportedVersion: "old" });
});

test("binary downloads enforce pinned digests and revalidate unpinned URLs after a release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zakura-agent-download-route-"));
  const previousDirectory = process.env.ZAKURA_AGENT_BINARIES_DIR;
  const previousVersion = process.env.ZAKURA_AGENT_VERSION;
  process.env.ZAKURA_AGENT_BINARIES_DIR = directory;
  process.env.ZAKURA_AGENT_VERSION = "test-release";
  t.mock.method(process, "cwd", () => join(directory, "apps", "server"));
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.ZAKURA_AGENT_BINARIES_DIR;
    else process.env.ZAKURA_AGENT_BINARIES_DIR = previousDirectory;
    if (previousVersion === undefined) delete process.env.ZAKURA_AGENT_VERSION;
    else process.env.ZAKURA_AGENT_VERSION = previousVersion;
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(256);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const binary = join(directory, "zakura-agent_linux_amd64");
  await writeFile(binary, bytes);
  const { app } = harness({
    async updateRunner() { throw new Error("unused"); },
    async systemVersion() { throw new Error("unused"); },
  });
  const path = "/api/runtime-nodes/agent-binaries/linux/amd64";
  const unpinned = await app.request(path);
  assert.equal(unpinned.headers.get("cache-control"), "no-cache");
  assert.deepEqual(Buffer.from(await unpinned.arrayBuffer()), bytes);
  const pinned = await app.request(`${path}?sha256=${digest}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.headers.get("content-length"), String(bytes.length));
  assert.equal(pinned.headers.get("x-zakura-agent-version"), "test-release");
  assert.equal(pinned.headers.get("x-zakura-agent-sha256"), digest);
  assert.match(pinned.headers.get("cache-control")!, /immutable/);
  assert.deepEqual(Buffer.from(await pinned.arrayBuffer()), bytes);
  const cached = await app.request(path, { headers: { "if-none-match": `"${digest}"` } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("etag"), `"${digest}"`);
  assert.equal(await cached.text(), "");
  const replacement = Buffer.from(bytes);
  replacement[255] = 1;
  await writeFile(`${binary}.new`, replacement);
  await rename(`${binary}.new`, binary);
  assert.equal((await app.request(`${path}?sha256=${digest}`)).status, 409);
  const current = await app.request(path, { headers: { "if-none-match": `"${digest}"` } });
  assert.equal(current.status, 200);
  assert.deepEqual(Buffer.from(await current.arrayBuffer()), replacement);
  assert.equal((await app.request("/api/runtime-nodes/agent-binaries/plan9/amd64")).status, 404);
});
