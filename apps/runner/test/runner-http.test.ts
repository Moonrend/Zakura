import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateRunnerToken } from "@zakura/core";
import { createAuthConfig } from "../src/auth.js";
import { createRunnerApp, agentWorkspaceRoot } from "../src/app.js";
import { startRunner } from "../src/index.js";

describe("Runner auth + FS + migration HTTP", () => {
  const { raw: token } = generateRunnerToken();
  const storageRoot = mkdtempSync(join(tmpdir(), "zakura-runner-store-"));
  const auth = createAuthConfig(token);
  const app = createRunnerApp({
    storageRoot,
    token,
    auth,
    version: "0.1.0-test",
  });

  it("GET /v1/ping works without auth", async () => {
    const res = await app.request("/v1/ping");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; version: string; storageRoot: string };
    assert.equal(body.ok, true);
    assert.ok(body.version);
    assert.equal(body.storageRoot, storageRoot);
  });

  it("rejects protected FS without token", async () => {
    const res = await app.request("/v1/agents/ag1/fs/list?path=/");
    assert.equal(res.status, 401);
  });

  it("rejects wrong token", async () => {
    const res = await app.request("/v1/agents/ag1/fs/list?path=/", {
      headers: { Authorization: "Bearer rnr_wrongtokenvalue000000000000" },
    });
    assert.equal(res.status, 401);
  });

  it("write + read with valid token", async () => {
    const agentId = "agent_http_1";
    const writeRes = await app.request(`/v1/agents/${agentId}/fs/write`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "/notes.txt", content: "from-runner" }),
    });
    assert.equal(writeRes.status, 200, await writeRes.text());

    const readRes = await app.request(`/v1/agents/${agentId}/fs/read?path=/notes.txt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(readRes.status, 200);
    const body = (await readRes.json()) as { content: string };
    assert.equal(body.content, "from-runner");
  });

  it("export excludes node_modules and import restores content", async () => {
    const agentId = "agent_mig_1";
    const root = agentWorkspaceRoot(storageRoot, agentId);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "keep.txt"), "keep-me", "utf8");
    writeFileSync(join(root, "src", "app.ts"), "console.log(1)", "utf8");
    writeFileSync(join(root, "node_modules", "x", "index.js"), "excluded", "utf8");

    const exp = await app.request(`/v1/agents/${agentId}/migration/export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sourceNodeId: "src-node" }),
    });
    const archive = Buffer.from(await exp.arrayBuffer());
    assert.equal(exp.status, 200, `export status ${exp.status} bodyLen=${archive.length}`);
    const sha = exp.headers.get("x-archive-sha256");
    assert.ok(sha);
    assert.ok(archive.length > 0);

    // Import into a different agent id (simulates different storage layout)
    const targetAgent = "agent_mig_target";
    const imp = await app.request(`/v1/agents/${targetAgent}/migration/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Archive-Sha256": sha!,
      },
      body: archive,
    });
    const impBody = await imp.text();
    assert.equal(imp.status, 200, impBody);
    const targetRoot = agentWorkspaceRoot(storageRoot, targetAgent);
    assert.equal(readFileSync(join(targetRoot, "keep.txt"), "utf8"), "keep-me");
    assert.equal(existsSync(join(targetRoot, "node_modules")), false);
    // source retained
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep-me");
    assert.ok(existsSync(join(root, "node_modules", "x", "index.js")));
  });

  after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
  });
});

describe("Runner process launch (real entrypoint)", () => {
  it("listens and serves ping twice with consistent body", async () => {
    const { raw: token } = generateRunnerToken();
    const storageRoot = mkdtempSync(join(tmpdir(), "zakura-runner-launch-"));
    // Use port 0 via env not supported by our start — pick high ports
    const port1 = 17443 + Math.floor(Math.random() * 1000);

    const r1 = await startRunner({
      port: port1,
      host: "127.0.0.1",
      storageRoot,
      token,
    });

    try {
      const ping1 = await fetch(`http://127.0.0.1:${r1.port}/v1/ping`);
      assert.equal(ping1.status, 200);
      const body1 = (await ping1.json()) as { ok: boolean; storageRoot: string };
      assert.equal(body1.ok, true);
      assert.equal(body1.storageRoot, storageRoot);

      const unauth = await fetch(
        `http://127.0.0.1:${r1.port}/v1/agents/x/fs/list?path=/`,
      );
      assert.equal(unauth.status, 401);

      // second launch on different port
      const port2 = port1 + 1;
      const r2 = await startRunner({
        port: port2,
        host: "127.0.0.1",
        storageRoot,
        token,
      });
      try {
        const ping2 = await fetch(`http://127.0.0.1:${r2.port}/v1/ping`);
        assert.equal(ping2.status, 200);
        const body2 = (await ping2.json()) as { ok: boolean };
        assert.equal(body2.ok, true);
      } finally {
        await r2.close();
      }
    } finally {
      await r1.close();
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
