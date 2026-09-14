import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Db } from "../src/db/client.js";
import type { RuntimeNodeService } from "../src/services/runtime-nodes.js";
import { ImageUpdateChecker } from "../src/services/image-update-checker.js";

let directory: string;
let digest: string;
let previousDirectory: string | undefined;
let previousVersion: string | undefined;

beforeEach(async (t) => {
  directory = await mkdtemp(join(tmpdir(), "zakura-image-update-checker-"));
  previousDirectory = process.env.ZAKURA_AGENT_BINARIES_DIR;
  previousVersion = process.env.ZAKURA_AGENT_VERSION;
  process.env.ZAKURA_AGENT_BINARIES_DIR = directory;
  process.env.ZAKURA_AGENT_VERSION = "new";
  t.mock.method(process, "cwd", () => join(directory, "apps", "server"));
  const bytes = Buffer.alloc(256);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(directory, "zakura-agent_linux_amd64"), bytes);
});

afterEach(async () => {
  if (previousDirectory === undefined) delete process.env.ZAKURA_AGENT_BINARIES_DIR;
  else process.env.ZAKURA_AGENT_BINARIES_DIR = previousDirectory;
  if (previousVersion === undefined) delete process.env.ZAKURA_AGENT_VERSION;
  else process.env.ZAKURA_AGENT_VERSION = previousVersion;
  await rm(directory, { recursive: true, force: true });
});

function harness(options: { docker?: boolean; failWorkspace?: boolean; gate?: Promise<void> } = {}) {
  const calls = { light: 0, full: 0, images: 0, select: 0 };
  const state = { sha256: "ab".repeat(32) };
  const info = () => ({ version: "old", goos: "linux", goarch: "amd64", sha256: state.sha256 });
  const node = { id: "node", tenantId: "owner", kind: "computer", agentVersion: "old" };
  const db = {
    query: { runtimeNodes: { async findFirst() { return node; } } },
    select() { calls.select++; return { from: () => ({ where: async () => [] }) }; },
  };
  const nodes = {
    async requireRunnerClient(_tenantId: string, _nodeId: string, request: { skipHeartbeatRefresh?: boolean }) {
      assert.equal(request.skipHeartbeatRefresh, true);
      return { client: {
        async systemVersion() { calls.light++; await options.gate; return { ...info(), image: "/agent", containerId: null }; },
        async ping() { calls.full++; return { ...info(), ok: true, docker: { ok: options.docker !== false } }; },
        async checkImageUpdates({ images, allowPullFallback }: { images: string[]; allowPullFallback: boolean }) {
          calls.images++;
          assert.equal(allowPullFallback, false, "automatic checks must not pull workspace images");
          if (options.failWorkspace) throw new Error("registry unavailable");
          return { images: images.map((image) => ({
            image, localId: "old-image", localDigest: "old-digest", remoteDigest: "new-digest",
            updateAvailable: true, runningStale: false, error: null,
          })) };
        },
      } };
    },
  };
  return { calls, state, checker: new ImageUpdateChecker(db as unknown as Db, nodes as unknown as RuntimeNodeService) };
}

test("agent-only checks use lightweight info without collecting or probing workspace images", async () => {
  const { checker, calls } = harness();
  const status = await checker.checkNode("node", { runnerOnly: true });
  assert.equal(status.error, null);
  assert.equal(status.entries.length, 1);
  assert.equal(status.entries[0].kind, "runner");
  assert.equal(status.entries[0].updateAvailable, true);
  assert.deepEqual(calls, { light: 1, full: 0, images: 0, select: 0 });
});

test("a computer without Docker still reports its agent update", async () => {
  const { checker, calls } = harness({ docker: false });
  const status = await checker.checkNode("node");
  assert.equal(status.error, null);
  assert.equal(status.entries.length, 1);
  assert.equal(status.hasUpdates, true);
  assert.equal(calls.images, 0);
});

test("workspace probe failures do not hide the independently checked agent update", async () => {
  const { checker } = harness({ failWorkspace: true });
  const status = await checker.checkNode("node");
  assert.equal(status.error, null);
  assert.equal(status.entries.find((entry) => entry.kind === "runner")?.updateAvailable, true);
  assert.match(status.entries.find((entry) => entry.kind === "workspace")!.error!, /registry unavailable/);
});

test("a fast agent refresh preserves cached workspace results and their original check time", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const { checker, state } = harness();
  const full = await checker.checkNode("node");
  now = 2000;
  state.sha256 = digest;
  const fast = await checker.checkNode("node", { runnerOnly: true });
  assert.equal(fast.checkedAt, 2000);
  assert.equal(fast.hasUpdates, false);
  const cached = checker.getAllStatuses()[0];
  assert.equal(cached.checkedAt, 1000);
  assert.equal(cached.hasUpdates, true);
  assert.deepEqual(cached.entries.find((entry) => entry.kind === "workspace"), full.entries.find((entry) => entry.kind === "workspace"));
  assert.equal(cached.entries.find((entry) => entry.kind === "runner")?.updateAvailable, false);
});

test("concurrent checks for the same node and scope share one probe", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { checker, calls } = harness({ gate });
  const first = checker.checkNode("node", { runnerOnly: true });
  const second = checker.checkNode("node", { runnerOnly: true });
  await nextTick();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls.light, 1);
  assert.deepEqual(results[0], results[1]);
});
