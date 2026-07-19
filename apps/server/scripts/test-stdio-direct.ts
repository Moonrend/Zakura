/**
 * Direct Docker integration test for stdio-mcp (npm / uvx / oci).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpProvider } from "../src/providers/stdio-mcp.js";
import { DockerRuntime } from "../src/runtime/docker.js";
import { mcpHttpRpc } from "../src/lib/mcp-http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const BRIDGE = join(ROOT, "apps/server/src/mcp/stdio-bridge.mjs");
const BAD = join(ROOT, "apps/server/src/providers/stdio-bridge.mjs");
const DATA = join(ROOT, "data", "stdio-direct-test");

type Case = {
  name: string;
  config: Record<string, unknown>;
  timeoutMs: number;
};

async function waitTools(url: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = (await mcpHttpRpc(url, {}, "tools/list", undefined, 20000)) as {
        tools?: Array<{ name: string }>;
      };
      const names = (result.tools ?? []).map((t) => t.name);
      if (names.length) return names;
      last = "empty tools";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`tools/list timeout: ${last}`);
}

async function runCase(runtime: DockerRuntime, c: Case): Promise<void> {
  const provider = createStdioMcpProvider();
  const instanceId = `test-${c.name}-${Date.now().toString(36)}`;
  const ctx = {
    tenantId: "test",
    instanceId,
    dataDir: DATA,
    db: null as unknown as never,
    resolveEndpoint: (hostPort: number, path = "") =>
      `http://127.0.0.1:${hostPort}${path.startsWith("/") || !path ? path : `/${path}`}`,
    logger: {
      info: (m: string, meta?: unknown) => console.log(`[${c.name}]`, m, meta ?? ""),
      warn: (m: string, meta?: unknown) => console.warn(`[${c.name}]`, m, meta ?? ""),
      error: (m: string, meta?: unknown) => console.error(`[${c.name}]`, m, meta ?? ""),
    },
  };

  const normalized = provider.validateConfig!(c.config);
  const spec = await provider.createRuntimeSpec(normalized, ctx);
  const containerSpec = spec.containers[0]!;
  const name = `zakura-test-${c.name}`.slice(0, 63);

  for (const ex of await runtime.list({ purpose: "component" })) {
    if (ex.name === name) await runtime.remove(ex.id, true);
  }

  mkdirSync(join(DATA, "stdio-mcp", instanceId), { recursive: true });
  for (const v of containerSpec.volumes ?? []) {
    if (!v.hostPath) continue;
    const n = v.hostPath.replace(/\\/g, "/");
    if (n.endsWith("docker.sock") || n.includes("/run/")) continue;
    if (existsSync(v.hostPath)) continue;
    if (v.readOnly) throw new Error(`missing file mount: ${v.hostPath}`);
    mkdirSync(v.hostPath, { recursive: true });
  }

  console.log(`[${c.name}] ensuring image ${containerSpec.image}`);
  await runtime.ensureImage(containerSpec.image);
  console.log(`[${c.name}] starting ${name}`);
  console.log(`[${c.name}] bridge mount`, containerSpec.volumes?.find((v) => v.containerPath.includes("stdio-bridge")));
  const running = await runtime.createAndStart({
    tenantId: "test",
    instanceId,
    purpose: "component",
    spec: { ...containerSpec, name, network: undefined },
  });

  try {
    const hostPort = running.ports.find((p) => p.hostPort)?.hostPort;
    if (!hostPort) throw new Error(`no published port: ${JSON.stringify(running.ports)}`);
    const url = `http://127.0.0.1:${hostPort}/mcp`;
    console.log(`[${c.name}] waiting tools at ${url}`);
    const tools = await waitTools(url, c.timeoutMs);
    console.log(`[${c.name}] PASS tools=${tools.length}:`, tools.slice(0, 8).join(", "));
  } finally {
    const logs = await runtime.logs(running.id, 100).catch(() => "");
    if (logs) console.log(`[${c.name}] logs tail:\n${logs.slice(-2000)}`);
    await runtime.remove(running.id, true);
  }
}

async function main() {
  console.log("bridge", BRIDGE, "exists=", existsSync(BRIDGE));
  if (!existsSync(BRIDGE)) throw new Error("bridge missing");
  if (existsSync(BAD)) {
    const { statSync } = await import("node:fs");
    if (statSync(BAD).isDirectory()) {
      rmSync(BAD, { recursive: true, force: true });
      console.log("removed bad providers/stdio-bridge.mjs directory");
    }
  }

  const runtime = new DockerRuntime();
  const ping = await runtime.ping();
  console.log("docker", ping);
  if (!ping.ok) throw new Error(`docker: ${ping.error}`);

  mkdirSync(DATA, { recursive: true });

  const cases: Case[] = [
    {
      name: "npm",
      timeoutMs: 180000,
      config: {
        command: "npx",
        args: JSON.stringify(["-y", "@modelcontextprotocol/server-everything"]),
        env: "{}",
        packageManager: "npm",
        workingDir: "/data",
      },
    },
    {
      name: "pypi",
      timeoutMs: 240000,
      config: {
        command: "uvx",
        args: JSON.stringify(["mcp-server-time"]),
        env: "{}",
        packageManager: "pypi",
        workingDir: "/data",
      },
    },
    {
      name: "oci",
      timeoutMs: 300000,
      config: {
        command: "docker",
        args: JSON.stringify(["run", "-i", "--rm", "node:22-bookworm-slim", "npx", "-y", "@modelcontextprotocol/server-everything"]),
        env: "{}",
        packageManager: "oci",
        workingDir: "/data",
      },
    },
  ];

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const c of cases) {
    try {
      await runCase(runtime, c);
      results.push({ name: c.name, ok: true, detail: "ok" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[${c.name}] FAIL`, detail);
      results.push({ name: c.name, ok: false, detail });
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

