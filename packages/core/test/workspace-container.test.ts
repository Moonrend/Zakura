import assert from "node:assert/strict";
import { it } from "node:test";
import { RunnerClient } from "../src/runner-client.js";

function clientFor(containers: unknown[]) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = new RunnerClient({ hub: {
    rpc: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "docker.list") return containers as T;
      return { exitCode: 0, stdout: "", stderr: "" } as T;
    },
  } });
  return { client, calls };
}

it("keeps desktop exec and stop on the workspace when ACP containers are listed first", async () => {
  for (const purpose of [undefined, "workspace"]) {
    const { client, calls } = clientFor([
      { dockerId: "adapter", status: "running", labels: { "zakura.agent": "a", "zakura.purpose": "acp-adapter" } },
      { dockerId: "sidecar", status: "running", labels: { "zakura.agent": "a", "zakura.purpose": "acp-sidecar" } },
      { dockerId: "workspace", status: "running", labels: { "zakura.agent": "a", ...(purpose ? { "zakura.purpose": purpose } : {}) } },
    ]);
    assert.equal((await client.getWorkspace("a"))?.dockerId, "workspace");
    await client.execWorkspace("a", ["xdotool", "getdisplaygeometry"]);
    await client.stopWorkspace("a");
    assert.equal(calls.find((call) => call.method === "docker.exec")?.params.id, "workspace");
    assert.equal(calls.find((call) => call.method === "docker.stop")?.params.id, "workspace");
  }
});

it("does not use an ACP container as a fallback for a missing workspace", async () => {
  const { client, calls } = clientFor([
    { dockerId: "adapter", status: "running", labels: { "zakura.agent": "a", "zakura.purpose": "acp-adapter" } },
  ]);
  assert.equal(await client.getWorkspace("a"), null);
  await assert.rejects(client.execWorkspace("a", ["scrot", "shot.png"]), /未运行/);
  await client.stopWorkspace("a");
  assert.equal(calls.some((call) => call.method === "docker.stop" || call.method === "docker.exec"), false);
});
