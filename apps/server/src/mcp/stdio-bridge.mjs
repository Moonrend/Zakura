#!/usr/bin/env node
/**
 * Minimal streamable-HTTP ↔ stdio MCP bridge.
 * Env:
 *   MCP_COMMAND  — executable (required)
 *   MCP_ARGS     — JSON array of args (default [])
 *   MCP_CWD      — working directory (optional)
 *   MCP_PORT     — listen port (default 3100)
 *   MCP_PATH     — HTTP path (default /mcp)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const COMMAND = process.env.MCP_COMMAND;
const ARGS = (() => {
  try {
    const raw = process.env.MCP_ARGS || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
})();
const CWD = process.env.MCP_CWD || process.cwd();
const PORT = Number(process.env.MCP_PORT || 3100);
const PATH = process.env.MCP_PATH || "/mcp";

if (!COMMAND) {
  console.error("[stdio-bridge] MCP_COMMAND is required");
  process.exit(1);
}

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let child = null;
/** @type {Map<number|string, {resolve:(v:unknown)=>void, reject:(e:Error)=>void}>} */
const pending = new Map();
let nextId = 1;
let ready = false;
let stderrBuf = "";

function startChild() {
  child = spawn(COMMAND, ARGS, {
    cwd: CWD,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.error("[stdio-bridge] non-json stdout:", trimmed.slice(0, 200));
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      // notification — ignore for now
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new Error(JSON.stringify(msg.error)));
    } else {
      waiter.resolve(msg.result);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    ready = false;
    const err = new Error(
      `MCP child exited code=${code} signal=${signal}${stderrBuf ? `: ${stderrBuf.slice(-500)}` : ""}`,
    );
    for (const [, w] of pending) w.reject(err);
    pending.clear();
    child = null;
  });
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    if (!child?.stdin || child.killed) {
      reject(new Error("MCP child not running"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    child.stdin.write(payload + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP RPC timeout: ${method}`));
      }
    }, 60000);
  });
}

async function ensureReady() {
  if (ready && child) return;
  if (!child) startChild();
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "zakura-stdio-bridge", version: "0.1.0" },
  });
  // notifications/initialized has no id
  if (child?.stdin) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }
  ready = true;
}

async function handleRpc(body) {
  await ensureReady();
  const method = body.method;
  const params = body.params;
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "zakura-stdio-bridge", version: "0.1.0" },
    };
  }
  if (method === "notifications/initialized" || method === "ping") {
    return method === "ping" ? {} : undefined;
  }
  if (method?.startsWith("notifications/")) {
    return undefined;
  }
  return send(method, params);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ready, command: COMMAND }));
    return;
  }
  if (url.pathname !== PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "zakura-stdio-bridge", version: "0.1.0" },
        },
        id: null,
      }),
    );
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }

  try {
    const result = await handleRpc(body);
    if (body.method?.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result: result ?? {} }));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[stdio-bridge] listening :${PORT}${PATH} → ${COMMAND} ${ARGS.join(" ")}`);
});

process.on("SIGTERM", () => {
  child?.kill("SIGTERM");
  server.close();
  process.exit(0);
});
