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
import { mcpResultToModelOutput, RESULT_TEXT_LIMIT } from "../src/services/cloud-agent/tools.js";

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

function a11yWorkspace() {
  const commands: string[][] = [];
  const node = (id: number, role: string, name: string) => ({
    handle: { bus: ":1.3", path: `/org/a11y/atspi/accessible/${id}`, signature: `identity-${id}` },
    depth: id === 1 ? 0 : 1, role, name, text: "", bounds: { x: 10, y: 20, width: 80, height: 30 },
    actions: role === "button" ? ["click"] : [], enabled: true, focusable: role !== "frame", focused: role === "text",
    editable: role === "text", showing: true, selected: false, checked: false,
  });
  const raw = {
    session: "bus-session-1", context: { name: "Desktop", activeWindow: { role: "frame", name: "Editor" }, applications: ["Editor"] },
    items: [node(1, "frame", "Editor"), node(2, "button", "Save"), { ...node(3, "text", "Document"), text: "Hello world" }],
    truncated: false, warnings: [] as string[],
  };
  const behavior = { snapshotError: "", resolveError: "", screenshotError: "", semantic: true, editableText: false };
  const requests: Array<{ command: string; args: Record<string, any> }> = [];
  const service = {
    ensureStarted: async () => agent,
    execInWorkspace: async (_agent: Agent, command: string[], opts: { env: Record<string, string> }) => {
      commands.push(command);
      assert.equal(opts.env.DISPLAY, ":99");
      let stdout = "", stderr = "";
      if (command.includes("getdisplaygeometry")) stdout = "1280 720\n";
      else if (command.includes("zakura-a11y")) {
        const operation = command.at(-2)!;
        const args = JSON.parse(command.at(-1)!);
        requests.push({ command: operation, args });
        if (operation === "snapshot") {
          stderr = behavior.snapshotError;
          stdout = JSON.stringify(raw);
        } else {
          stderr = behavior.resolveError;
          stdout = JSON.stringify(behavior.semantic && args.mode !== "point"
            ? { handled: true, typed: args.mode === "type" && behavior.editableText, method: args.mode === "click" ? "at-spi-action" : "at-spi-focus" }
            : { points: args.targets.map((_: unknown, i: number) => ({ x: 101 + i * 100, y: 202 + i * 100 })), method: "at-spi-bounds" });
        }
      } else if (command.join(" ").includes("base64")) {
        stdout = png;
        stderr = behavior.screenshotError;
      }
      return { exitCode: stderr ? 1 : 0, stdout, stderr };
    },
  } as unknown as AgentWorkspaceService;
  const observe = async (args: Record<string, unknown> = {}) => {
    const result = await callAgentNativeTool(agent, service, "computer_observe", args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find((part) => part.type === "text")!.text);
  };
  return { service, commands, requests, raw, behavior, observe };
}

describe("desktop accessibility snapshots and refs", () => {
  it("returns desktop context, a text tree and actionable refs, optionally with an intact image", async () => {
    const { service } = a11yWorkspace();
    const result = await callAgentNativeTool(agent, service, "computer_observe", { screenshot: true });
    assert.notEqual(result.isError, true);
    const output = mcpResultToModelOutput(result);
    const data = JSON.parse(output.text);
    assert.equal(data.backend, "at-spi");
    assert.equal(data.context.activeWindow.name, "Editor");
    assert.match(data.snapshot, /e2 \[button\] "Save"/);
    assert.match(data.snapshot, /e3 \[text\].*focusable.*focused.*text="Hello world"/);
    assert.equal(data.items[1].ref, "e2");
    assert.ok(!JSON.stringify(result).includes("identity-"), "backend handles must stay private");
    assert.equal(output.parts?.find((part) => part.type === "image_url")?.imageUrl.url, `data:image/png;base64,${png}`);
  });

  it("snapshot → ref click uses the live AT-SPI action and ignores even invalid fallback coordinates", async () => {
    const { service, commands, requests, observe, raw } = a11yWorkspace();
    const snapshot = await observe();
    const result = await callAgentNativeTool(agent, service, "computer_click", { ref: snapshot.items[1].ref, x: -100, y: "ignored" });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(requests.at(-1)?.args.targets, [raw.items[1]!.handle]);
    assert.equal(requests.at(-1)?.args.session, raw.session);
    assert.equal(requests.at(-1)?.args.mode, "click");
    assert.match(JSON.stringify(result), /at-spi-action/);
    assert.ok(!commands.some((command) => command.includes("mousemove")), "must not duplicate a semantic click with a physical click");
  });

  it("uses live ref bounds for double/right clicks and pointer actions", async () => {
    for (const [name, args] of [
      ["computer_click", { double: true }], ["computer_click", { button: "right" }],
      ["computer_move", {}], ["computer_scroll", { dy: 2 }],
    ] as const) {
      const { service, commands, requests, observe } = a11yWorkspace();
      const { items } = await observe();
      const result = await callAgentNativeTool(agent, service, name, { ...args, ref: items[1].ref });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(requests.at(-1)?.args.mode, "point");
      const command = commands.find((command) => command.includes("mousemove"))!;
      assert.deepEqual(command.slice(command.indexOf("mousemove") + 1, command.indexOf("mousemove") + 3), ["101", "202"]);
    }
  });

  it("focuses the ref before typing literal text; failed focus never types into the current window", async () => {
    const { service, commands, requests, observe, behavior } = a11yWorkspace();
    const { items } = await observe();
    const text = "new\n'quoted' $HOME $(echo bad) `echo bad`";
    const result = await callAgentNativeTool(agent, service, "computer_type", { ref: items[2].ref, text });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(requests.at(-1)?.args.mode, "type");
    assert.equal(requests.at(-1)?.args.text, text);
    assert.equal(commands.at(-1)?.at(-1), text);
    behavior.resolveError = "Desktop ref did not take focus; no text was sent.";
    commands.length = 0;
    const failed = await callAgentNativeTool(agent, service, "computer_type", { ref: items[2].ref, text, x: 1, y: 1 });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /computer_observe observe=snapshot/);
    assert.ok(!commands.some((command) => command.includes("type") || command.includes("mousemove")));
  });

  it("does not send duplicate keystrokes after native accessible text insertion", async () => {
    const { service, commands, behavior, requests, observe } = a11yWorkspace();
    const { items } = await observe();
    behavior.editableText = true;
    const text = "中文🙂\n'quoted' $HOME";
    const result = await callAgentNativeTool(agent, service, "computer_type", { ref: items[2].ref, text });
    assert.notEqual(result.isError, true);
    assert.equal(requests.at(-1)?.args.text, text);
    assert.ok(!commands.some((command) => command.includes("type")));
  });

  it("checks both drag refs before pressing a button and supports a coordinate destination", async () => {
    const { service, commands, requests, observe } = a11yWorkspace();
    const { items } = await observe();
    const result = await callAgentNativeTool(agent, service, "computer_drag", { ref: items[1].ref, to_ref: items[2].ref });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(requests.at(-1)?.args.targets.length, 2);
    assert.match(commands.at(-1)!.join(" "), /mousemove 101 202 mousedown 1/);
    assert.match(commands.at(-1)!.join(" "), /mousemove 201 302/);
    assert.match(commands.at(-1)!.join(" "), /trap 'xdotool mouseup 1' EXIT/);
    const mixed = await callAgentNativeTool(agent, service, "computer_drag", { ref: items[1].ref, to_x: 300, to_y: 400 });
    assert.notEqual(mixed.isError, true);
    assert.equal(requests.at(-1)?.args.targets.length, 1);
    commands.length = 0;
    const bad = await callAgentNativeTool(agent, service, "computer_drag", { ref: items[1].ref, to_ref: "e999", to_x: 10, to_y: 10 });
    assert.equal(bad.isError, true);
    assert.ok(!commands.some((command) => command.join(" ").includes("mousedown")));
  });

  it("rejects unknown, replaced, expired and cross-agent refs without coordinate fallback", async (t) => {
    const { service, commands, observe } = a11yWorkspace();
    let snapshot = await observe();
    const original = snapshot.items[1].ref;
    snapshot = await observe();
    assert.notEqual(original, snapshot.items[1].ref, "new snapshots must not recycle eN names");
    for (const ref of [original, "e9999", "", null]) {
      commands.length = 0;
      const result = await callAgentNativeTool(agent, service, "computer_click", { ref, x: 10, y: 10 });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /computer_observe observe=snapshot/);
      assert.ok(!commands.some((command) => command.includes("mousemove") || command.includes("resolve")));
    }
    snapshot = await observe();
    const foreign = await callAgentNativeTool({ ...agent, tenantId: "another-tenant" }, service, "computer_click", { ref: snapshot.items[1].ref });
    assert.equal(foreign.isError, true);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
    const expired = await callAgentNativeTool(agent, service, "computer_click", { ref: snapshot.items[1].ref });
    assert.equal(expired.isError, true);
    assert.match(JSON.stringify(expired), /stale|missing/);
  });

  it("requires a fresh snapshot on backend staleness and after a failed replacement snapshot", async () => {
    const { service, commands, behavior, observe } = a11yWorkspace();
    const { items } = await observe();
    behavior.resolveError = "Desktop accessibility session changed; refs are stale.";
    const result = await callAgentNativeTool(agent, service, "computer_click", { ref: items[1].ref, x: 10, y: 10 });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /session changed.*snapshot/);
    assert.ok(!commands.some((command) => command.includes("mousemove")));
    behavior.resolveError = "";
    const fresh = await observe();
    behavior.snapshotError = "Desktop accessibility bus unavailable";
    assert.equal((await callAgentNativeTool(agent, service, "computer_observe", {})).isError, true);
    assert.equal((await callAgentNativeTool(agent, service, "computer_click", { ref: fresh.items[1].ref })).isError, true);
    assert.notEqual((await callAgentNativeTool(agent, service, "computer_observe", { observe: "screenshot" })).isError, true, "screenshots must work without AT-SPI");
    assert.notEqual((await callAgentNativeTool(agent, service, "computer_click", { x: 10, y: 10 })).isError, true);
  });

  it("does not duplicate refresh guidance when ref resolution already includes it", async () => {
    const { service, behavior, observe } = a11yWorkspace();
    const { items } = await observe();
    behavior.resolveError = "Desktop ref changed. Run computer_observe observe=snapshot again.";
    const result = await callAgentNativeTool(agent, service, "computer_click", { ref: items[1].ref });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.equal((text.match(/Run computer_observe observe=snapshot again\./g) ?? []).length, 1);
  });

  it("serializes a ref action and a competing new snapshot", async (t) => {
    const { service, requests, observe } = a11yWorkspace();
    const { items } = await observe();
    const original = service.execInWorkspace.bind(service);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    t.after(() => release());
    t.mock.method(service, "execInWorkspace", async (...args: Parameters<typeof service.execInWorkspace>) => {
      if (args[1].includes("resolve")) { entered(); await gate; }
      return original(...args);
    });
    const click = callAgentNativeTool(agent, service, "computer_click", { ref: items[1].ref });
    await resolving;
    const nextSnapshot = observe();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.filter((request) => request.command === "snapshot").length, 1);
    release();
    assert.notEqual((await click).isError, true);
    const next = await nextSnapshot;
    assert.notEqual(next.items[1].ref, items[1].ref);
    assert.deepEqual(requests.map((request) => request.command), ["snapshot", "resolve", "snapshot"]);
  });

  it("preserves the snapshot on screenshot failure and bounds output to complete JSON/ref lines", async () => {
    const { service, raw, behavior, observe } = a11yWorkspace();
    behavior.screenshotError = "capture backend failed";
    const snapshot = await observe({ screenshot: true });
    assert.match(snapshot.warnings.join(" "), /Snapshot succeeded.*screenshot failed/);
    assert.notEqual((await callAgentNativeTool(agent, service, "computer_click", { ref: snapshot.items[1].ref })).isError, true);
    behavior.screenshotError = "";
    raw.items = Array.from({ length: 500 }, (_, i) => ({ ...raw.items[1]!, name: `Button ${i} ${"label".repeat(30)}`, text: "long text ".repeat(40) }));
    const result = await callAgentNativeTool(agent, service, "computer_observe", { max_nodes: 500, screenshot: true });
    const model = mcpResultToModelOutput(result);
    assert.ok(model.text.length < RESULT_TEXT_LIMIT);
    const data = JSON.parse(model.text);
    assert.equal(data.truncated, true);
    assert.equal(data.snapshot.split("\n").length, data.items.length);
    assert.equal(data.count, data.items.length);
    raw.context.applications = Array.from({ length: 100 }, () => "Application ".repeat(30));
    behavior.screenshotError = "Screenshot failure ".repeat(300);
    const largeContext = await callAgentNativeTool(agent, service, "computer_observe", { max_nodes: 500, screenshot: true });
    const bounded = JSON.parse(mcpResultToModelOutput(largeContext).text);
    assert.equal(bounded.context.applicationsTruncated, true);
    assert.match(bounded.warnings.at(-1), /screenshot failed/);
  });

  it("exposes ref-only schemas and rejects invalid observation arguments before workspace execution", async () => {
    const tools = listAgentNativeTools(agent);
    assert.ok(tools.some((tool) => tool.localName === "computer_observe"));
    for (const name of ["computer_click", "computer_type", "computer_move", "computer_scroll", "computer_drag"]) {
      const tool = tools.find((tool) => tool.localName === name)!;
      assert.ok((tool.inputSchema.properties as Record<string, unknown>).ref);
      assert.ok(!(tool.inputSchema.required as string[] | undefined)?.includes("x"));
    }
    for (const args of [{ observe: "invalid" }, { max_nodes: 501 }, { max_nodes: 1.5 }, { path: "../escape.png", screenshot: true }, { path: "shot.png" }, { output: "invalid" }]) {
      const { service, commands } = a11yWorkspace();
      const result = await callAgentNativeTool(agent, service, "computer_observe", args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(commands.length, 0);
    }
    const { service, commands } = a11yWorkspace();
    const disabled = await callAgentNativeTool({ ...agent, enableComputer: false }, service, "computer_observe", {});
    assert.equal(disabled.isError, true);
    assert.equal(commands.length, 0);
  });
});

describe("desktop native tools", () => {
  it("returns clear errors when ref and coordinate targets are both missing", async () => {
    for (const [name, args, pattern] of [
      ["computer_click", {}, /Provide ref or x\/y\./],
      ["computer_move", {}, /Provide ref or x\/y\./],
      ["computer_scroll", { dy: 1 }, /Provide ref or x\/y\./],
      ["computer_drag", { x: 1, y: 2 }, /Provide to_ref or to_x\/to_y\./],
      ["computer_drag", { to_x: 3, to_y: 4 }, /Provide ref or x\/y\./],
    ] as const) {
      const { service, commands } = workspace();
      const result = await callAgentNativeTool(agent, service, name, args);
      assert.equal(result.isError, true, JSON.stringify({ name, args }));
      assert.match(JSON.stringify(result), pattern);
      assert.ok(!commands.some((command) => command.join(" ").includes("mousemove")));
    }
  });

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
