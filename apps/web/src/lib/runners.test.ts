import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerUpdateStatus } from "@zakura/shared";
import { updateRunner } from "./runners.ts";

function job(phase: RunnerUpdateStatus["phase"] = "queued"): RunnerUpdateStatus {
  return {
    id: "job-1", nodeId: "node", version: "new", sha256: "ab".repeat(32), phase,
    downloadedBytes: 0, totalBytes: 0, startedAt: Date.now(), updatedAt: Date.now(), error: null,
  };
}

test("self-update waits for a completed background job and reports its progress", async (t) => {
  const phases: RunnerUpdateStatus["phase"][] = [];
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal, "both the start request and polls need bounded HTTP timeouts");
    if (init?.method === "POST") {
      assert.equal(String(input), "/api/runtime-nodes/node/update-runner");
      return Response.json({ image: "https://download.example/agent", scheduled: true, update: job() });
    }
    assert.equal(String(input), "/api/runtime-nodes/node/update-runner?id=job-1");
    polls++;
    return Response.json({ update: job(polls === 1 ? "downloading" : "completed") });
  });
  const result = await updateRunner("node", {}, (progress) => phases.push(progress.phase));
  assert.deepEqual(phases, ["queued", "downloading", "completed"]);
  assert.equal(polls, 2, "polls must bypass the API response cache");
  assert.equal(result.scheduled, false);
  assert.equal(result.version, "new");
});

test("transient timeout and proxy errors do not turn an ongoing update into a failure", async (t) => {
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ scheduled: true, update: job() });
    polls++;
    if (polls === 1) throw new DOMException("poll timed out", "TimeoutError");
    if (polls === 2) return Response.json({ error: "temporary proxy failure" }, { status: 503 });
    return Response.json({ update: job("completed") });
  });
  assert.equal((await updateRunner("node")).update.phase, "completed");
  assert.equal(polls, 3);
});

test("an agent's failed result is surfaced without another update request", async (t) => {
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      starts++;
      return Response.json({ scheduled: true, update: job() });
    }
    return Response.json({ update: { ...job("failed"), error: "代理重启失败" } });
  });
  await assert.rejects(updateRunner("node"), /代理重启失败/);
  assert.equal(starts, 1);
});

test("an expired job stops polling and asks for a fresh version check", async (t) => {
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ scheduled: true, update: job() });
    polls++;
    return Response.json({ error: "更新任务不存在或已过期" }, { status: 404 });
  });
  await assert.rejects(updateRunner("node"), /已过期/);
  assert.equal(polls, 1);
});

test("polling has an overall deadline even if the job remains active", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ scheduled: true, update: job() });
    now += 13 * 60_000;
    return Response.json({ update: job("restarting") });
  });
  await assert.rejects(updateRunner("node"), /等待更新结果超时/);
});

test("a missing job id is not treated as a successful update", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ scheduled: true }));
  await assert.rejects(updateRunner("node"), /未收到更新任务/);
});
