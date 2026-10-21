// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs in the selected workspace, not in the server process. This is not a JS
// security sandbox: the workspace's existing execution policy is the boundary.
import readline from "node:readline";

const output = [];
const pending = new Map();
const maxOutputBytes = 24000;
const maxCalls = 128;
let outputBytes = 0;
let truncated = false;
let seq = 0;
let running = false;

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const text = (...values) => {
  if (truncated) return;
  const value = values.map((value) => typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).join(" ");
  const encoded = Buffer.from(value);
  const remaining = Math.max(0, maxOutputBytes - outputBytes);
  if (encoded.length > remaining) {
    output.push(encoded.subarray(0, remaining).toString("utf8"));
    truncated = true;
    return;
  }
  output.push(value);
  outputBytes += encoded.length + 1;
};

const request = (op, fields) => {
  if (seq >= maxCalls) return Promise.reject(new Error("codemode tool call limit exceeded (128)"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      write({ op, id, ...fields });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
};

const tools = new Proxy(Object.create(null), {
  get: (_target, name) => {
    // Do not accidentally turn the namespace into a thenable or inspect hook.
    if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined;
    return (args = {}) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return Promise.reject(new Error("tool arguments must be an object"));
      }
      return request("call", { name, args });
    };
  },
});
const searchTools = async (query = "", options = {}) => {
  const result = await request("discover", { args: { ...options, query } });
  return result;
};
const describeTool = async (name) => {
  const result = await request("discover", { args: { names: [name], includeSchemas: true } });
  return result.tools[0];
};
const consoleShim = { log: text, error: text, warn: text, info: text, debug: text };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const finish = (message) => {
  process.stdout.write(JSON.stringify({ ...message, output, truncated }) + "\n", () => process.exit(0));
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object") return;
  if (message.op === "result") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(String(message.error)));
    return;
  }
  if (message.op === "run" && !running) {
    running = true;
    try {
      const fn = new AsyncFunction("tools", "text", "console", "searchTools", "describeTool", String(message.code ?? ""));
      const result = await fn(tools, text, consoleShim, searchTools, describeTool);
      if (pending.size) throw new Error("Unawaited tool calls: await all tool promises before returning");
      if (result !== undefined) text(result);
      finish({ op: "done", ok: true });
    } catch (error) {
      finish({ op: "done", ok: false, error: String(error?.message || error).slice(0, 4000) });
    }
  }
});
