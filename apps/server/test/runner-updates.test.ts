import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerUpdateProgress } from "@zakura/shared";
import { RunnerUpdates, RunnerUpdateConflictError } from "../src/services/runner-updates.js";

const target = {
  url: "https://download.example/agent", sha256: "ab".repeat(32),
  version: "new-version", filename: "zakura-agent_linux_amd64",
};
const liveInfo = { version: "running-version", sha256: target.sha256, image: "/bin/agent", containerId: null };
const options = { pollIntervalMs: 1, reconnectTimeoutMs: 30 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "background update did not settle");
    await delay(1);
  }
}

test("updates start in the background, deduplicate per node and retain progress snapshots", async () => {
  const gate = deferred();
  let calls = 0;
  let report!: (progress: RunnerUpdateProgress) => void;
  const updates = new RunnerUpdates(async (tenantId, nodeId) => {
    assert.equal(tenantId, "owner");
    assert.equal(nodeId, "node");
    return {
      async updateRunner(body, onProgress) {
        calls++;
        assert.equal(body.url, target.url);
        assert.equal(body.sha256, target.sha256);
        report = onProgress!;
        report({ phase: "downloading", downloadedBytes: 40, totalBytes: 100 });
        await gate.promise;
        return { image: body.image, scheduled: true };
      },
      async systemVersion() { return liveInfo; },
    };
  }, options);
  const first = updates.start("owner", "node", target);
  assert.equal(first.phase, "queued");
  await until(() => calls === 1);
  const duplicate = updates.start("owner", "node", { ...target, sha256: target.sha256.toUpperCase() });
  assert.equal(duplicate.id, first.id);
  assert.throws(() => updates.start("owner", "node", { ...target, sha256: "cd".repeat(32) }), RunnerUpdateConflictError);
  assert.equal(calls, 1);
  duplicate.phase = "failed";
  assert.equal(updates.get("node")?.phase, "downloading");
  assert.equal(updates.get("node", "another-job"), null);
  report({ phase: "verifying", downloadedBytes: 0, totalBytes: 0 });
  assert.equal(updates.get("node")?.downloadedBytes, 40);
  assert.equal(updates.get("node")?.totalBytes, 100);
  gate.resolve();
  await until(() => updates.get("node")?.phase === "completed");
  assert.equal(updates.get("node")?.version, liveInfo.version);
  assert.equal(first.phase, "queued", "returned snapshots must not mutate after the HTTP response");
});

test("different nodes can download concurrently", async () => {
  const gate = deferred();
  const downloading = new Set<string>();
  const updates = new RunnerUpdates(async (_tenantId, nodeId) => ({
    async updateRunner(body) {
      downloading.add(nodeId);
      await gate.promise;
      return { image: body.image, scheduled: true };
    },
    async systemVersion() { return liveInfo; },
  }), options);
  updates.start("owner", "one", target);
  updates.start("owner", "two", target);
  await until(() => downloading.size === 2);
  gate.resolve();
  await until(() => ["one", "two"].every((nodeId) => updates.get(nodeId)?.phase === "completed"));
});

test("a lost acknowledgement is successful only after reconnecting with the target digest", async () => {
  for (const message of ["连接关闭", "sys.update 超时", "replaced", "WebSocket is not open"]) {
    let connections = 0;
    let probes = 0;
    const updates = new RunnerUpdates(async () => {
      if (++connections === 2) throw new Error("temporarily offline");
      return {
        async updateRunner() { throw new Error(message); },
        async systemVersion() {
          probes++;
          return { ...liveInfo, sha256: probes === 1 ? "cd".repeat(32) : probes === 2 ? undefined : target.sha256.toUpperCase() };
        },
      };
    }, { ...options, reconnectTimeoutMs: 1000 });
    updates.start("owner", "node", target);
    await until(() => updates.get("node")?.phase === "completed");
    assert.equal(probes, 3, "a matching version string alone is not proof of a restart");
  }
});

test("an explicit update error fails immediately and a retry can complete without restarting", async () => {
  let fail = true;
  let probes = 0;
  const updates = new RunnerUpdates(async () => ({
    async updateRunner(body) {
      if (fail) throw new Error("校验和不匹配");
      return { image: body.image, scheduled: false, alreadyCurrent: true, note: "已是目标版本" };
    },
    async systemVersion() { probes++; return liveInfo; },
  }), options);
  const failed = updates.start("owner", "node", target);
  await until(() => updates.get("node")?.phase === "failed");
  assert.match(updates.get("node")!.error!, /校验和/);
  assert.equal(probes, 0);
  fail = false;
  const retried = updates.start("owner", "node", target);
  assert.notEqual(retried.id, failed.id);
  assert.equal(updates.get("node", failed.id), null);
  await until(() => updates.get("node")?.phase === "completed");
  assert.equal(updates.get("node")?.note, "已是目标版本");
});

test("restart failures reported by the surviving agent are surfaced", async () => {
  const updates = new RunnerUpdates(async () => ({
    async updateRunner(body) { return { image: body.image, scheduled: true }; },
    async systemVersion() { return { ...liveInfo, updateError: "代理重启失败: access denied" }; },
  }), options);
  updates.start("owner", "node", target);
  await until(() => updates.get("node")?.phase === "failed");
  assert.match(updates.get("node")!.error!, /access denied/);
});

test("reconnect waiting is bounded and never treats an unverified old agent as completed", async () => {
  const updates = new RunnerUpdates(async () => ({
    async updateRunner(body) { return { image: body.image, scheduled: true }; },
    async systemVersion() { return { ...liveInfo, sha256: undefined }; },
  }), options);
  updates.start("owner", "node", target);
  await until(() => updates.get("node")?.phase === "failed");
  assert.match(updates.get("node")!.error!, /未确认目标代理重新上线/);
});

test("an unavailable initial connection becomes an observable failed job", async () => {
  const updates = new RunnerUpdates(async () => { throw new Error("代理当前离线"); }, options);
  const job = updates.start("owner", "node", target);
  await until(() => updates.get("node")?.phase === "failed");
  assert.equal(updates.get("node", job.id)?.error, "代理当前离线");
});
