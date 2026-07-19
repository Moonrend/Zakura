import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioMcpProvider } from "../src/providers/stdio-mcp.js";
import { DockerRuntime } from "../src/runtime/docker.js";
import { mcpHttpRpc } from "../src/lib/mcp-http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA = join(ROOT, "data", "stdio-direct-test");

async function main() {
  const runtime = new DockerRuntime();
  const ping = await runtime.ping();
  if (!ping.ok) throw new Error(ping.error);
  const provider = createStdioMcpProvider();
  const instanceId = `test-oci-${Date.now().toString(36)}`;
  const ctx = {
    tenantId: "test",
    instanceId,
    dataDir: DATA,
    db: null as never,
    resolveEndpoint: (p: number) => `http://127.0.0.1:${p}`,
    logger: { info: console.log, warn: console.warn, error: console.error },
  };
  const config = provider.validateConfig!({
    command: "docker",
    args: JSON.stringify([
      "run", "-i", "--rm",
      "node:22-bookworm-slim",
      "npx", "-y", "@modelcontextprotocol/server-everything",
    ]),
    env: "{}",
    packageManager: "oci",
    workingDir: "/data",
  });
  const spec = await provider.createRuntimeSpec(config, ctx);
  const cs = spec.containers[0]!;
  const name = "zakura-test-oci2";
  for (const ex of await runtime.list({ purpose: "component" })) {
    if (ex.name === name) await runtime.remove(ex.id, true);
  }
  mkdirSync(join(DATA, "stdio-mcp", instanceId), { recursive: true });
  for (const v of cs.volumes ?? []) {
    if (!v.hostPath) continue;
    const n = v.hostPath.replace(/\\/g, "/");
    if (n.endsWith("docker.sock") || /\/run\//.test(n)) continue;
    if (!existsSync(v.hostPath) && !v.readOnly) mkdirSync(v.hostPath, { recursive: true });
  }
  await runtime.ensureImage(cs.image);
  console.log("starting", name, "cmd", config.command, config.args);
  const running = await runtime.createAndStart({
    tenantId: "test", instanceId, purpose: "component",
    spec: { ...cs, name, network: undefined },
  });
  try {
    const hostPort = running.ports.find((p) => p.hostPort)?.hostPort;
    if (!hostPort) throw new Error("no port");
    const url = `http://127.0.0.1:${hostPort}/mcp`;
    const deadline = Date.now() + 240000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const r = await mcpHttpRpc(url, {}, "tools/list", undefined, 20000) as { tools?: {name:string}[] };
        if (r.tools?.length) {
          console.log("PASS oci tools=", r.tools.length, r.tools.slice(0,5).map(t=>t.name).join(","));
          return;
        }
        last = "empty";
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const logs = await runtime.logs(running.id, 120);
    console.error("FAIL", last);
    console.error(logs.slice(-2500));
    process.exit(1);
  } finally {
    await runtime.remove(running.id, true);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
