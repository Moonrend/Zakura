import assert from "node:assert/strict";
import test from "node:test";
import type { DockerPullEvent } from "@zakura/shared";
import { RunnerClient, type HubRpc } from "../src/runner-client.js";

function harness() {
  const listeners = new Map<string, (chan: string, data: Buffer) => void>();
  const requests: Array<{ stream: string; resolve: () => void; reject: (error: Error) => void }> = [];
  const hub: HubRpc = {
    onStream(id, listener) {
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    },
    rpc: async <T>(method: string, params: unknown) => {
      assert.equal(method, "docker.pull");
      const { image, progressStream } = params as { image: string; progressStream: string };
      assert.equal(image, "registry.test/acp:1");
      assert.ok(listeners.has(progressStream), "subscribe before starting the RPC");
      await new Promise<void>((resolve, reject) => requests.push({ stream: progressStream, resolve, reject }));
      return undefined as T;
    },
  };
  const emit = (stream: string, event: DockerPullEvent) =>
    listeners.get(stream)?.("progress", Buffer.from(JSON.stringify(event)));
  return { client: new RunnerClient({ hub }), listeners, requests, emit };
}

test("concurrent remote image pulls have isolated progress streams and release subscriptions", async () => {
  const { client, listeners, requests, emit } = harness();
  const first: DockerPullEvent[] = [];
  const second: DockerPullEvent[] = [];
  const a = client.pullImage("registry.test/acp:1", (_line, event) => first.push(event!));
  const b = client.pullImage("registry.test/acp:1", (_line, event) => second.push(event!));
  assert.notEqual(requests[0].stream, requests[1].stream);
  emit(requests[0].stream, { id: "layer", status: "Downloading", progressDetail: { current: 25, total: 100 } });
  assert.equal(first[0].progressDetail?.current, 25);
  assert.equal(first[0].zakura?.image, "registry.test/acp:1");
  assert.deepEqual(second, []);
  requests[0].resolve();
  requests[1].resolve();
  await Promise.all([a, b]);
  assert.equal(listeners.size, 0);
});

test("failed, timed out and disconnected pulls release progress subscriptions", async () => {
  for (const message of ["pull access denied", "docker.pull 超时", "连接关闭"]) {
    const { client, listeners, requests } = harness();
    const pull = client.pullImage("registry.test/acp:1", () => undefined);
    requests[0].reject(new Error(message));
    await assert.rejects(pull, { message });
    assert.equal(listeners.size, 0);
  }
});

test("bad progress frames and observers do not interrupt a pull", async () => {
  const { client, listeners, requests, emit } = harness();
  let calls = 0;
  const pull = client.pullImage("registry.test/acp:1", () => {
    calls++;
    throw new Error("observer failed");
  });
  listeners.get(requests[0].stream)!("progress", Buffer.from("not JSON"));
  emit(requests[0].stream, { status: "Pull complete" });
  requests[0].resolve();
  await pull;
  assert.equal(calls, 1);
  assert.equal(listeners.size, 0);
});

test("legacy hubs and agents can complete pulls without progress support", async () => {
  for (const supportsStreams of [false, true]) {
    let removed = false;
    const client = new RunnerClient({ hub: {
      ...(supportsStreams ? { onStream: () => () => { removed = true; } } : {}),
      rpc: async <T>(_method: string, params: unknown) => {
        assert.equal((params as { image: string }).image, "registry.test/acp:1");
        if (!supportsStreams) assert.deepEqual(params, { image: "registry.test/acp:1" });
        return undefined as T;
      },
    } });
    await client.pullImage("registry.test/acp:1", () => assert.fail("old agents do not emit frames"));
    assert.equal(removed, supportsStreams);
  }
});
