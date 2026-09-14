import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerUpdateProgress } from "@zakura/shared";
import { RunnerClient, type HubRpc } from "../src/runner-client.js";

const target = { image: "https://download.example/agent", sha256: "ab".repeat(32), version: "new" };
type Reply = { ok?: boolean; alreadyCurrent?: boolean; note?: string };

function harness() {
  const listeners = new Map<string, (channel: string, data: Buffer) => void>();
  const requests: Array<{ stream: string; resolve: (reply: Reply) => void; reject: (error: Error) => void }> = [];
  const hub: HubRpc = {
    onStream(id, listener) {
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    },
    async rpc<T>(method: string, params: unknown, timeoutMs?: number) {
      assert.equal(method, "sys.update");
      assert.ok(timeoutMs! > 10 * 60_000, "RPC must outlive the agent's ten-minute download timeout");
      const body = params as { url: string; sha256: string; restart: boolean; progressStream: string };
      assert.equal(body.url, target.image);
      assert.equal(body.sha256, target.sha256);
      assert.equal(body.restart, true);
      assert.ok(listeners.has(body.progressStream), "subscribe before sending sys.update");
      return await new Promise<Reply>((resolve, reject) => {
        requests.push({ stream: body.progressStream, resolve, reject });
      }) as T;
    },
  };
  const emit = (stream: string, event: unknown) => listeners.get(stream)?.("progress", Buffer.from(JSON.stringify(event)));
  return { client: new RunnerClient({ hub }), listeners, requests, emit };
}

test("version probes use lightweight sys.info with a bounded timeout and retain the running digest", async () => {
  const client = new RunnerClient({ hub: {
    async rpc<T>(method: string, params: unknown, timeoutMs?: number) {
      assert.equal(method, "sys.info");
      assert.deepEqual(params, { light: true });
      assert.ok(timeoutMs! <= 10_000);
      return { version: "new", binPath: "/agent", sha256: target.sha256, goos: "linux", goarch: "amd64", updateError: "restart failed" } as T;
    },
  } });
  const info = await client.systemVersion();
  assert.equal(info.sha256, target.sha256);
  assert.equal(info.image, "/agent");
  assert.equal(info.updateError, "restart failed");
});

test("concurrent updates isolate progress streams and release them on completion", async () => {
  const { client, listeners, requests, emit } = harness();
  const first: RunnerUpdateProgress[] = [];
  const second: RunnerUpdateProgress[] = [];
  const a = client.updateRunner(target, (progress) => first.push(progress));
  const b = client.updateRunner(target, (progress) => second.push(progress));
  assert.notEqual(requests[0].stream, requests[1].stream);
  emit(requests[0].stream, { phase: "downloading", downloadedBytes: 25, totalBytes: 100 });
  assert.deepEqual(first, [{ phase: "downloading", downloadedBytes: 25, totalBytes: 100 }]);
  assert.deepEqual(second, []);
  requests[0].resolve({ ok: true });
  requests[1].resolve({ ok: true, alreadyCurrent: true, note: "已是目标版本" });
  const [scheduled, current] = await Promise.all([a, b]);
  assert.equal(scheduled.scheduled, true);
  assert.equal(current.scheduled, false);
  assert.equal(current.note, "已是目标版本");
  assert.equal(listeners.size, 0);
});

test("failed, timed out and disconnected updates release progress subscriptions", async () => {
  for (const message of ["校验和不匹配", "sys.update 超时", "连接关闭"]) {
    const { client, listeners, requests } = harness();
    const update = client.updateRunner(target, () => undefined);
    requests[0].reject(new Error(message));
    await assert.rejects(update, { message });
    assert.equal(listeners.size, 0);
  }
  const { client, listeners, requests } = harness();
  const rejectedReply = client.updateRunner(target, () => undefined);
  requests[0].resolve({ ok: false, note: "replace failed" });
  await assert.rejects(rejectedReply, /replace failed/);
  assert.equal(listeners.size, 0);
});

test("malformed frames and failing progress observers do not interrupt an update", async () => {
  const { client, listeners, requests, emit } = harness();
  const received: RunnerUpdateProgress[] = [];
  const update = client.updateRunner(target, (progress) => {
    received.push(progress);
    throw new Error("observer failed");
  });
  const stream = requests[0].stream;
  listeners.get(stream)!("progress", Buffer.from("not JSON"));
  emit(stream, null);
  emit(stream, { phase: "completed", downloadedBytes: 100, totalBytes: 100 });
  emit(stream, { phase: "downloading", downloadedBytes: -1, totalBytes: "100" });
  assert.deepEqual(received, [{ phase: "downloading", downloadedBytes: 0, totalBytes: 0 }]);
  requests[0].resolve({ ok: true });
  await update;
  assert.equal(listeners.size, 0);
});

test("legacy hubs and agents can update without progress support", async () => {
  const client = new RunnerClient({ hub: {
    async rpc<T>(_method: string, params: unknown) {
      assert.deepEqual(params, { url: target.image, sha256: target.sha256, version: target.version, restart: true });
      return undefined as T;
    },
  } });
  const result = await client.updateRunner(target, () => assert.fail("legacy agent emitted progress"));
  assert.equal(result.scheduled, true);
});
