/**
 * 对真实 Agent MCP（/mcp/agents/:slug）跑 @modelcontextprotocol/conformance。
 *
 * 官方套件不支持自定义 Authorization，因此本脚本在本机起转发代理，
 * 注入 ZAKURA_MCP_API_KEY 为 Bearer（不测 OAuth）。
 *
 * 环境变量：
 *   ZAKURA_MCP_URL      — 必填，例如 http://127.0.0.1:8787/mcp/agents/demo
 *   ZAKURA_MCP_API_KEY  — 必填，Agent API Key（zak_…）
 *   MCP_CONFORMANCE_PROXY_PORT — 代理端口，默认 3098
 *
 * 用法（需先启动 Zakura server）：
 *   pnpm mcp:conformance
 *   pnpm mcp:conformance -- --scenario server-initialize
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetUrl = (process.env.ZAKURA_MCP_URL ?? "").trim().replace(/\/$/, "");
const apiKey = (process.env.ZAKURA_MCP_API_KEY ?? "").trim();
const proxyPort = Number(process.env.MCP_CONFORMANCE_PROXY_PORT || 3098);
const extraArgs = process.argv.slice(2);

/** 工具型网关默认可验证的场景；不维护 everything 夹具 */
const DEFAULT_SCENARIOS = [
  "server-initialize",
  "ping",
  "tools-list",
  "resources-list",
  "prompts-list",
  "resources-templates-list",
] as const;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
): Promise<void> {
  const incoming = new URL(req.url || "/", `http://127.0.0.1:${proxyPort}`);
  const dest = new URL(target.pathname + incoming.search, target);
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await readBody(req);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (key === "host" || key === "authorization" || key === "content-length") {
      continue;
    }
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers.host = target.host;
  headers.authorization = `Bearer ${apiKey}`;
  if (body && body.length > 0) {
    headers["content-length"] = String(body.length);
  }

  try {
    const resp = await fetch(dest, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return;
      outHeaders[key] = value;
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    res.writeHead(resp.status, outHeaders);
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: "proxy_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function waitReady(url: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "conformance-ready-check", version: "0.0.0" },
          },
        }),
      });
      if (res.ok || res.status === 400 || res.status === 406) return;
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `鉴权失败 HTTP ${res.status}：检查 ZAKURA_MCP_API_KEY 是否绑定该 Agent`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("鉴权失败")) throw err;
    }
    await sleep(300);
  }
  throw new Error(`真实 MCP 未就绪: ${url}`);
}

if (!targetUrl) {
  console.error(
    "缺少 ZAKURA_MCP_URL，例如 http://127.0.0.1:8787/mcp/agents/<slug>",
  );
  process.exit(1);
}
if (!apiKey) {
  console.error("缺少 ZAKURA_MCP_API_KEY（Agent API Key，Bearer zak_…）");
  process.exit(1);
}

let target: URL;
try {
  target = new URL(targetUrl);
} catch {
  console.error(`无效 ZAKURA_MCP_URL: ${targetUrl}`);
  process.exit(1);
}

const proxyUrl = `http://127.0.0.1:${proxyPort}/mcp`;
const proxy = createServer((req, res) => {
  void forward(req, res, target);
});

await new Promise<void>((resolve, reject) => {
  proxy.listen(proxyPort, "127.0.0.1", () => resolve());
  proxy.on("error", reject);
});

console.log(`[mcp:conformance] target  ${targetUrl}`);
console.log(`[mcp:conformance] proxy   ${proxyUrl} → inject Bearer`);

try {
  await waitReady(targetUrl);
} catch (err) {
  console.error(err);
  proxy.close();
  process.exit(1);
}

async function runOne(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      [
        "--yes",
        "@modelcontextprotocol/conformance@0.1.16",
        "server",
        "--url",
        proxyUrl,
        ...args,
      ],
      { cwd: root, env: process.env, stdio: "inherit", shell: true },
    );
    child.on("exit", (c) => resolve(c ?? 1));
  });
}

let exitCode = 0;
if (extraArgs.length > 0) {
  exitCode = await runOne(extraArgs);
} else {
  for (const scenario of DEFAULT_SCENARIOS) {
    console.log(`\n=== scenario: ${scenario} ===`);
    const code = await runOne(["--scenario", scenario]);
    if (code !== 0) exitCode = code;
  }
}

proxy.close();
process.exit(exitCode);
