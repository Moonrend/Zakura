import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { LocalWorkspaceFs } from "@zakura/core";
import { registerAgentFsRoutes } from "../src/api/agent-fs-routes.js";
import type { Agent } from "../src/db/schema.js";
import { callAgentNativeTool } from "../src/services/agent-tools.js";
import { readWorkspaceFsResource } from "../src/services/agent-mcp-primitives.js";
import { screenshotPath } from "../src/services/agent-screenshot.js";
import type { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import type { AgentBrowserService } from "../src/services/agent-cdp.js";
import { makePng } from "./helpers/png.js";

const agent = { id: "path-test", tenantId: "t1", enableComputer: true, enableFs: true } as Agent;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zakura-fs-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fs = new LocalWorkspaceFs(root);
  const png = makePng(2, 2);
  const commands: string[][] = [];
  const workspace = {
    ensureLocal: () => root,
    ensureStarted: async () => agent,
    execInWorkspace: async (_agent: Agent, command: string[]) => {
      commands.push(command);
      return { exitCode: 0, stdout: command.join(" ").includes("getdisplaygeometry") ? "1280 720\n" : png, stderr: "" };
    },
  } as unknown as AgentWorkspaceService;
  const browser = { observe: async () => ({ base64Full: png }) } as unknown as AgentBrowserService;
  const aliases = (path: string) => [path, `/${path}`, `/workspace/${path}`, join(root, path)];
  return { root, fs, png, workspace, browser, commands, aliases };
}

describe("workspace paths across native tools and APIs", () => {
  it("screenshot paths accept workspace aliases and reject only escapes or non-file paths", () => {
    for (const path of ["shots/a.png", "/shots/a.png", "/workspace/shots/a.png", "shots/old/../a.png", "..shots/a.png"]) {
      assert.ok(screenshotPath(path), path);
    }
    for (const path of ["../a.png", "/workspace/../a.png", "shots/../../a.png", "..\\a.png", "a\0b", "", "/", "/workspace", ".", "shots/..", 1, null]) {
      assert.throws(() => screenshotPath(path), undefined, String(path));
    }
    assert.equal(screenshotPath(undefined), undefined);
  });

  it("reads, edits and moves the same file with every supported alias", async (t) => {
    const { root, workspace, aliases } = await fixture(t);
    for (const path of aliases("data/a.txt")) {
      const write = await callAgentNativeTool(agent, workspace, "fs_write", { path, content: "hello" });
      assert.notEqual(write.isError, true, JSON.stringify(write));
      const edit = await callAgentNativeTool(agent, workspace, "fs_edit", { path, old_text: "hello", new_text: "world" });
      assert.notEqual(edit.isError, true, JSON.stringify(edit));
      const read = await callAgentNativeTool(agent, workspace, "fs_read", { path });
      assert.notEqual(read.isError, true, JSON.stringify(read));
      assert.match(JSON.stringify(read), /world/);
    }
    const moved = await callAgentNativeTool(agent, workspace, "fs_move", { from: "/workspace/data/a.txt", to: "/data/b.txt" });
    assert.notEqual(moved.isError, true, JSON.stringify(moved));
    assert.equal(await readFile(join(root, "data/b.txt"), "utf8"), "world");
  });

  for (const name of ["computer_screenshot", "computer_observe", "browser_observe"]) {
    it(`${name} saves all aliases to the workspace and returns a reusable path`, async (t) => {
      const { root, workspace, browser, png, aliases } = await fixture(t);
      for (const path of aliases("shots/a.png")) {
        const result = await callAgentNativeTool(agent, workspace, name, { path, observe: "screenshot" }, browser);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.deepEqual(await readFile(join(root, "shots/a.png")), Buffer.from(png, "base64"));
        const metadata = JSON.parse(result.content.find((part) => part.type === "text")!.text);
        assert.ok(!metadata.savedPath.includes(root), metadata.savedPath);
        const st = await callAgentNativeTool(agent, workspace, "fs_stat", { path: metadata.savedPath });
        assert.notEqual(st.isError, true, JSON.stringify(st));
      }
    });
  }

  it("fs_grep resolves aliases before sending paths to the container and rejects escapes", async (t) => {
    const { root, fs, workspace, commands, aliases } = await fixture(t);
    await fs.write("data/a.txt", "hello");
    for (const path of aliases("data/a.txt")) {
      const result = await callAgentNativeTool(agent, workspace, "fs_grep", { path, pattern: "hello" });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(commands.at(-1)?.[2]?.includes("'/workspace/data/a.txt'"), JSON.stringify(commands.at(-1)));
      assert.ok(!commands.at(-1)?.[2]?.includes(root));
    }
    commands.length = 0;
    const result = await callAgentNativeTool(agent, workspace, "fs_grep", { path: "../outside", pattern: "hello" });
    assert.equal(result.isError, true);
    assert.equal(commands.length, 0);
  });

  it("scrubs known host roots from native filesystem errors including jail errors", async (t) => {
    const { root, workspace } = await fixture(t);
    for (const path of [join(root, "missing.txt"), `${root}/../outside`]) {
      const result = await callAgentNativeTool(agent, workspace, "fs_read", { path });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes(root), JSON.stringify(result));
    }
  });

  it("MCP filesystem resources round-trip aliases and scrub read errors", async (t) => {
    const { root, fs, aliases } = await fixture(t);
    await fs.write("data/a.txt", "hello");
    for (const path of aliases("data/a.txt")) {
      const result = await readWorkspaceFsResource(fs, `zakura://agent/fs/${encodeURIComponent(path)}`);
      assert.equal(result?.contents[0]?.text, "hello");
    }
    await assert.rejects(readWorkspaceFsResource(fs, "zakura://agent/fs/missing.txt"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(root), err.message);
      return true;
    });
    await assert.rejects(readWorkspaceFsResource(fs, "zakura://agent/fs/%2E%2E/outside"));
  });

  it("HTTP filesystem routes accept API paths and scrub the actual root on errors", async (t) => {
    const { root, fs, aliases } = await fixture(t);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("session" as never, { tenantId: agent.tenantId } as never);
      await next();
    });
    registerAgentFsRoutes(app as never, { get: async () => agent } as never, { forAgentBinding: async () => fs } as never, {} as never);
    await fs.write("data/a.txt", "hello");
    for (const path of aliases("data/a.txt")) {
      const response = await app.request(`/api/agents/${agent.id}/fs/read?${new URLSearchParams({ path })}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.content, "hello");
      assert.equal(body.path, "/data/a.txt");
    }
    const missing = await app.request(`/api/agents/${agent.id}/fs/read?path=missing.txt`);
    assert.equal(missing.status, 404);
    assert.ok(!(await missing.text()).includes(root));
    const escape = await app.request(`/api/agents/${agent.id}/fs/read?path=..%2Foutside`);
    assert.equal(escape.status, 403);
  });
});
