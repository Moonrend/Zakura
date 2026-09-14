import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { Agent } from "../src/db/schema.js";
import type { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import { callAgentNativeTool, listAgentNativeTools } from "../src/services/agent-tools.js";
import { screenshotResult, pngDimensions } from "../src/services/agent-screenshot.js";
import { makePng } from "./helpers/png.js";

const agent = { id: "desktop-test", tenantId: "t1", enableComputer: true } as Agent;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

function workspace(failAction = false) {
  const commands: string[][] = [];
  const service = {
    ensureStarted: async () => agent,
    getDesktopInfo: async () => ({ enabled: true, containerStatus: "running", width: 1280, height: 720 }),
    execInWorkspace: async (_agent: Agent, command: string[]) => {
      commands.push(command);
      if (command.join(" ").includes("getdisplaygeometry")) return { exitCode: 0, stdout: "1280 720\n", stderr: "" };
      if (command.join(" ").includes("base64")) return { exitCode: 0, stdout: png, stderr: "" };
      return failAction
        ? { exitCode: 1, stdout: "", stderr: "Can't open display: :99" }
        : { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as AgentWorkspaceService;
  return { service, commands };
}

describe("desktop native tools", () => {
  it("uses xdotool repeat clicks for double click and returns display coordinates", async () => {
    const { service, commands } = workspace();
    const result = await callAgentNativeTool(agent, service, "computer_click", { x: 12, y: 34, double: true });
    assert.notEqual(result.isError, true);
    const command = commands.find((c) => c.join(" ").includes("mousemove"))!;
    assert.ok(command.includes("--repeat"), JSON.stringify(command));
    assert.ok(!command.join(" ").includes("dblclick"));
    assert.match(JSON.stringify(result), /1280/);
    assert.match(JSON.stringify(result), /720/);
  });

  it("passes typed text as a literal argument, outside shell source", async () => {
    const { service, commands } = workspace();
    const text = "line 1\n'quoted' $HOME $(printf expanded) `printf expanded`";
    await callAgentNativeTool(agent, service, "computer_type", { text });
    const command = commands.at(-1)!;
    assert.ok(command.includes(text), JSON.stringify(command));
    assert.notEqual(command[2], text);
  });

  it("marks execution failures as tool errors with DISPLAY diagnostics", async () => {
    const { service } = workspace(true);
    const result = await callAgentNativeTool(agent, service, "computer_move", { x: 12, y: 34 });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /:99/);
  });

  it("rejects invalid coordinates before any input is sent", async () => {
    for (const x of [NaN, Infinity, -1, 0.5, 1280, "12"]) {
      const { service, commands } = workspace();
      const result = await callAgentNativeTool(agent, service, "computer_click", { x, y: 12 });
      assert.equal(result.isError, true, String(x));
      assert.ok(!commands.some((c) => c.join(" ").includes("mousemove")));
    }
  });

  it("returns an intact MCP image and the PNG's actual size", async () => {
    const { service } = workspace();
    const result = await callAgentNativeTool(agent, service, "computer_screenshot", {});
    const image = result.content.find((c) => c.type === "image");
    assert.deepEqual(image, { type: "image", data: png, mimeType: "image/png" });
    const metadata = JSON.parse(result.content.find((c) => c.type === "text")!.text);
    assert.equal(metadata.width, 1);
    assert.equal(metadata.height, 1);
    assert.equal(metadata.base64Full, undefined);
  });

  it("exposes bounded wait, drag and optional observations", () => {
    const tools = listAgentNativeTools(agent);
    assert.ok(tools.some((t) => t.localName === "computer_drag"));
    assert.ok(tools.some((t) => t.localName === "computer_wait"));
    const click = tools.find((t) => t.localName === "computer_click")!;
    assert.ok((click.inputSchema.properties as Record<string, unknown>).screenshot);
  });

  it("rejects screenshot path traversal without executing workspace commands", async () => {
    for (const path of ["../escape.png", "/workspace/../escape.png", "a/../../escape.png", "..\\escape.png", "a\0b"]) {
      const { service, commands } = workspace();
      const result = await callAgentNativeTool(agent, service, "computer_screenshot", { path });
      assert.equal(result.isError, true, path);
      assert.equal(commands.length, 0);
    }
  });

  it("does not turn a zero scroll into a click", async () => {
    const { service, commands } = workspace();
    const result = await callAgentNativeTool(agent, service, "computer_scroll", { x: 10, y: 10, dy: 0 });
    assert.notEqual(result.isError, true);
    assert.ok(!commands.some((c) => c.includes("click")));
  });

  it("executes literal input and screenshot fallback, never reuses an old capture", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zakura-desktop-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const bin of ["mktemp", "rm", "base64", "bash"]) await symlink(`/usr/bin/${bin}`, join(dir, bin));
    const log = join(dir, "input.json");
    const marker = join(dir, "expanded");
    const stub = async (name: string, script: string) => writeFile(join(dir, name), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    await stub("xdotool", `const fs = require('node:fs'); const args = process.argv.slice(2); if (args[0] === 'getdisplaygeometry') console.log('1280 720'); else fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));`);
    await stub("scrot", "console.error('scrot backend failed'); process.exit(1);");
    await stub("import", `require('node:fs').writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(png)}, 'base64'));`);
    const service = {
      ensureStarted: async () => agent,
      execInWorkspace: async (_agent: Agent, command: string[], opts: { env?: Record<string, string> }) => {
        try {
          const result = await promisify(execFile)(`/usr/bin/${command[0]}`, command.slice(1), { env: { ...process.env, ...opts.env, PATH: dir }, timeout: 5000 });
          return { ...result, exitCode: 0 };
        } catch (err) {
          const result = err as Error & { stdout: string; stderr: string; code: number };
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
        }
      },
    } as unknown as AgentWorkspaceService;
    const text = `two\nlines ' \" $HOME $(touch ${marker}) \`touch ${marker}\``;
    assert.notEqual((await callAgentNativeTool(agent, service, "computer_type", { text })).isError, true);
    assert.equal(JSON.parse(await readFile(log, "utf8")).at(-1), text);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const success = await callAgentNativeTool(agent, service, "computer_screenshot", {});
    assert.equal(success.content.find((c) => c.type === "image")?.data, png);
    await stub("import", "console.error('Cannot open display :99'); process.exit(1);");
    const failure = await callAgentNativeTool(agent, service, "computer_screenshot", {});
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure), /DISPLAY=:99/);
    assert.equal(failure.content.some((c) => c.type === "image"), false);
    await rm(join(dir, "scrot"));
    await rm(join(dir, "import"));
    const missing = await callAgentNativeTool(agent, service, "computer_screenshot", {});
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /install scrot.*import.*xwd/);
  });
});

describe("screenshot output limits", () => {
  it("preserves large images and only includes complete base64 when requested", () => {
    const large = makePng(300, 180);
    assert.ok(large.length > 120_000);
    const result = screenshotResult({ base64Full: large });
    assert.equal(result.content.find((c) => c.type === "image")?.data, large);
    assert.ok(result.content.find((c) => c.type === "text")!.text.length < 1000);
    assert.throws(() => screenshotResult({ base64Full: large }, "base64"), /too large/);
    assert.equal(screenshotResult({ base64Full: large }, "metadata").content.length, 1);
    const full = screenshotResult({ base64Full: png }, "base64");
    assert.equal(JSON.parse(full.content.find((c) => c.type === "text")!.text).base64Full, png);
  });

  it("rejects empty, non-PNG and truncated output", () => {
    for (const value of ["", "not base64", Buffer.from("not a PNG").toString("base64"), png.slice(0, -16)]) {
      assert.throws(() => pngDimensions(value), /Screenshot/);
    }
    assert.throws(() => screenshotResult({ base64Full: png }, "invalid"), /output must be/);
  });
});
