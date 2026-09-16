import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Agent } from "../src/db/schema.js";
import type { AgentWorkspaceService } from "../src/services/agent-workspace.js";
import { callAgentNativeTool } from "../src/services/agent-tools.js";

it("operates real GTK controls through snapshot refs on an isolated AT-SPI desktop", {
  skip: process.env.ZAKURA_TEST_DESKTOP_A11Y !== "1",
  timeout: 40_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zakura-atspi-"));
  let fixture: ChildProcess | undefined;
  t.after(async () => {
    if (fixture?.pid) {
      const exited = new Promise<void>((resolve) => fixture!.once("exit", () => resolve()));
      try { process.kill(-fixture.pid, "SIGTERM"); } catch { /* Already exited. */ }
      if (fixture.exitCode === null && fixture.signalCode === null) {
        const timer = setTimeout(() => { try { process.kill(-fixture!.pid!, "SIGKILL"); } catch { /* Already exited. */ } }, 2000);
        await exited;
        clearTimeout(timer);
      }
    }
    await rm(dir, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  });
  const helper = fileURLToPath(new URL("../../../docker/workspace/desktop-a11y.py", import.meta.url));
  await writeFile(join(dir, "zakura-desktop-a11y"), `#!/bin/sh\nexec /usr/bin/python3 '${helper.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const environment = { ...process.env, XDG_RUNTIME_DIR: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache") };
  const child = spawn("dbus-run-session", ["--", "/usr/bin/python3", fileURLToPath(new URL("helpers/desktop-a11y-fixture.py", import.meta.url))], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  fixture = child;
  let errors = "";
  child.stderr.on("data", (data) => { errors += String(data); });
  const ready = await new Promise<{ display: string; bus: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GTK fixture did not start: ${errors}`)), 8000);
    const lines = createInterface({ input: child.stdout });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(errors)); });
    lines.on("line", (line) => {
      if (line.startsWith('{"display":')) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
  });
  const agent = { id: "atspi-integration", tenantId: "t", enableComputer: true } as Agent;
  const service = {
    ensureStarted: async () => agent,
    execInWorkspace: async (_agent: Agent, command: string[], opts: { env: Record<string, string> }) => {
      try {
        const result = await promisify(execFile)(command[0]!, command.slice(1), {
          env: { ...environment, ...opts.env, DISPLAY: ready.display, DBUS_SESSION_BUS_ADDRESS: ready.bus, PATH: `${dir}:${process.env.PATH}` },
          timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        });
        return { ...result, exitCode: 0 };
      } catch (err) {
        const failure = err as Error & { stdout: string; stderr: string; code: number };
        return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code };
      }
    },
  } as unknown as AgentWorkspaceService;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await callAgentNativeTool(agent, service, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find((part) => part.type === "text")!.text);
  };
  let snapshot = await call("computer_observe");
  for (let i = 0; i < 20 && !snapshot.items.some((item: any) => item.name === "Save"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = await call("computer_observe");
  }
  const ref = (name: string) => {
    const item = snapshot.items.find((item: any) => item.name === name);
    assert.ok(item, `${name} missing from ${snapshot.snapshot}`);
    return item.ref as string;
  };
  assert.equal(snapshot.context.activeWindow.name, "Zakura AT-SPI fixture");
  assert.ok(!JSON.stringify(snapshot).includes("fixture-secret"), "password contents must not be read");
  assert.match((await call("computer_click", { ref: ref("Message") })).method, /bounds/);
  assert.equal((await call("computer_type", { ref: ref("Message"), text: "original 中文" })).method, "at-spi-editable-text");
  await call("computer_key", { ref: ref("Message"), key: "ctrl+a" });
  await call("computer_type", { ref: ref("Message"), text: "" });
  const text = "draft ' $HOME `literal` 中文🙂";
  await call("computer_type", { ref: ref("Message"), text });
  await call("computer_type", { ref: ref("Message"), text: "!" });
  const savedRef = ref("Save");
  assert.equal((await call("computer_click", { ref: savedRef })).method, "at-spi-action");
  const stale = await callAgentNativeTool(agent, service, "computer_click", { ref: savedRef, x: 1, y: 1 });
  assert.equal(stale.isError, true, "changing the same object's name must invalidate its old handle");
  assert.match(JSON.stringify(stale), /ref changed.*snapshot/);
  snapshot = await call("computer_observe");
  assert.ok(snapshot.items.some((item: any) => item.name === `Saved: ${text}!`), snapshot.snapshot);
  assert.ok(!snapshot.snapshot.includes("Unexpected entry activation"), "clicking a text ref must not activate/submit it");
  await call("computer_move", { ref: ref("Message") });
});
