import assert from "node:assert/strict";
import test from "node:test";
import { RunnerClient } from "@zakura/core";
import type { DockerPullEvent } from "@zakura/shared";
import { HubSession } from "../src/services/runner-hub.js";
import { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import { AcpRegistryService } from "../src/services/acp/registry.js";
import { AcpSessionService } from "../src/services/acp/session.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  let pull: { id: string; params: { progressStream: string; image: string } } | undefined;
  const hub = new HubSession("runner", {
    OPEN: 1,
    readyState: 1,
    send(raw: string, callback?: (error?: Error) => void) {
      const msg = JSON.parse(raw);
      if (msg.method === "docker.images") {
        queueMicrotask(() => hub.handle(Buffer.from(JSON.stringify({
          type: "res", id: msg.id, ok: true, result: [],
        }))));
      } else if (msg.method === "docker.pull") {
        pull = msg;
      } else {
        assert.fail(`unexpected RPC ${msg.method}`);
      }
      callback?.();
    },
    close() {},
  } as never);
  const client = new RunnerClient({ hub });
  const workspace = Object.create(AgentWorkspaceService.prototype) as AgentWorkspaceService;
  Object.assign(workspace, {
    requireRunnerClient: async () => ({ client, node: { id: "runner" } }),
  });
  const sessions = new AcpSessionService({
    workspace,
    acpRegistry: new AcpRegistryService(workspace),
    agentService: {} as never,
    store: {} as never,
  });
  const agent = {
    id: "remote-progress",
    tenantId: "tenant",
    runtimeNodeId: "runner",
    configJson: JSON.stringify({ acp: { agents: { fx: { enabled: true, setupMode: "self" } } } }),
  } as never;
  return {
    sessions, agent, hub,
    get pull() { return pull; },
    progress(event: DockerPullEvent) {
      assert.ok(pull, "pull RPC should be pending");
      hub.handle(Buffer.from(JSON.stringify({
        type: "stream", stream: pull.params.progressStream, chan: "progress",
        data: Buffer.from(JSON.stringify(event)).toString("base64"),
      })));
    },
    finish(error?: string) {
      assert.ok(pull);
      hub.handle(Buffer.from(JSON.stringify({ type: "res", id: pull.id, ok: !error, error })));
    },
  };
}

test("Go progress frames reach ACP install snapshots before docker.pull completes", async (t) => {
  const h = harness();
  t.after(() => h.hub.close());
  assert.equal(h.sessions.startInstall(h.agent, "fx").state, "queued");
  await flush();
  assert.ok(h.pull);
  h.progress({ id: "layer-a", status: "Downloading", progressDetail: { current: 25, total: 100 } });
  const [progress] = h.sessions.listInstalls("remote-progress");
  assert.equal(progress.state, "pulling");
  assert.equal(progress.percent, 25);
  assert.equal(progress.downloadedBytes, 25);
  assert.equal(progress.totalBytes, 100);
  assert.equal(progress.image, h.pull.params.image);
  h.progress({ id: "layer-a", status: "Extracting", progressDetail: { current: 100, total: 500 } });
  assert.equal(h.sessions.listInstalls("remote-progress")[0].totalBytes, 100);
  h.finish();
  await flush();
  assert.equal(h.sessions.listInstalls("remote-progress")[0].state, "completed");
  assert.equal(h.sessions.listInstalls("remote-progress")[0].percent, 100);
});

test("remote pull failure and connection loss finish the install job as failed", async (t) => {
  for (const disconnected of [false, true]) {
    const h = harness();
    t.after(() => h.hub.close());
    h.sessions.startInstall(h.agent, "fx");
    await flush();
    h.progress({ id: "layer-a", status: "Waiting" });
    assert.equal(h.sessions.listInstalls("remote-progress")[0].percent, null);
    if (disconnected) h.hub.close("连接关闭");
    else h.finish("pull access denied");
    await flush();
    const [progress] = h.sessions.listInstalls("remote-progress");
    assert.equal(progress.state, "failed");
    assert.match(progress.error!, disconnected ? /连接关闭/ : /pull access denied/);
    assert.ok(progress.finishedAt);
  }
});
