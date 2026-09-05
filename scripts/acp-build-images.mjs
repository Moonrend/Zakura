#!/usr/bin/env node
/**
 * Build (and smoke-test) ACP adapter images from scripts/acp-images.json.
 *
 * Every adapter becomes its own OCI image whose CMD *is* the adapter, speaking
 * ACP JSON-RPC over stdio. This script is the local half of that pipeline: it
 * builds each image and then proves the container actually speaks ACP before
 * declaring success. A build that produces an image which cannot complete an
 * `initialize` handshake is a failed build here, not a runtime surprise.
 *
 * Usage:
 *   node scripts/acp-build-images.mjs                 # build all enabled
 *   node scripts/acp-build-images.mjs --only goose,gemini
 *   node scripts/acp-build-images.mjs --all           # include disabled
 *   node scripts/acp-build-images.mjs --no-smoke      # build only
 *   node scripts/acp-build-images.mjs --keep-going    # don't stop at first failure
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MANIFEST = path.join(HERE, "acp-images.json");
const CONTEXT = path.join(ROOT, "docker", "acp-adapter");

// Matches PROTOCOL_VERSION in the ACP client code.
const PROTOCOL_VERSION = 1;
const SMOKE_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const out = {
    only: null,
    all: false,
    smoke: true,
    keepGoing: false,
    // GHCR namespaces are lowercase; the repo is github.com/Moonrend/Zakura.
    registry: "ghcr.io/moonrend/zakura",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (a === "--all") out.all = true;
    else if (a === "--no-smoke") out.smoke = false;
    else if (a === "--keep-going") out.keepGoing = true;
    else if (a === "--registry") out.registry = argv[++i];
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const log = (...m) => console.log(...m);
const warn = (...m) => console.error(...m);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (opts.echo) process.stdout.write(d);
    });
    p.stderr.on("data", (d) => {
      err += d;
      if (opts.echo) process.stderr.write(d);
    });
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

function imageTag(registry, agent) {
  return `${registry}/acp-${agent.id}:${agent.version}`;
}

async function build(agent, opts) {
  const tag = imageTag(opts.registry, agent);
  const args = [
    "build",
    "-f",
    path.join(CONTEXT, "Dockerfile"),
    "-t",
    tag,
    "-t",
    `${opts.registry}/acp-${agent.id}:latest`,
    "--build-arg",
    `ACP_ID=${agent.id}`,
    "--build-arg",
    `ACP_KIND=${agent.kind}`,
    "--build-arg",
    `ACP_VERSION=${agent.version ?? ""}`,
    "--build-arg",
    `ACP_ARGS=${JSON.stringify(agent.args ?? [])}`,
    "--build-arg",
    `ACP_ENV=${JSON.stringify(agent.env ?? {})}`,
  ];
  if (agent.kind === "binary") {
    args.push("--build-arg", `ACP_ARCHIVE=${agent.archive}`);
    args.push("--build-arg", `ACP_CMD=${agent.cmd}`);
    if (agent.sha256) args.push("--build-arg", `ACP_SHA256=${agent.sha256}`);
  } else {
    args.push("--build-arg", `ACP_PACKAGE=${agent.package}`);
  }
  args.push(CONTEXT);

  log(`\n=== build ${agent.id} -> ${tag}`);
  const r = await run("docker", args, { echo: true });
  return { ok: r.code === 0, tag, err: r.err };
}

/**
 * Drive a real ACP `initialize` over the container's stdio.
 *
 * This is the assertion that matters: not "did the binary land in the image"
 * but "does PID 1 answer the protocol on stdout". It catches CRLF-mangled
 * entrypoints, wrong bin names, missing glibc, and adapters that print banners
 * to stdout and desync the stream.
 */
function smoke(tag, agentId) {
  return new Promise((resolve) => {
    // No --entrypoint override: the image's own ENTRYPOINT is exactly what the
    // runtime will attach to, so the smoke test must exercise that same path.
    // Network is left enabled because some adapters resolve credentials or
    // print an auth prompt during initialize; they must still answer the frame.
    const p = spawn("docker", ["run", "--rm", "-i", tag], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        p.kill("SIGKILL");
      } catch {}
      resolve({ ok, reason, stdout, stderr });
    };

    const timer = setTimeout(
      () => finish(false, `no initialize response within ${SMOKE_TIMEOUT_MS}ms`),
      SMOKE_TIMEOUT_MS,
    );

    p.on("error", (e) => finish(false, `spawn failed: ${e}`));

    p.stdout.on("data", (d) => {
      stdout += d;
      // ACP frames are newline-delimited JSON.
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let msg;
        try {
          msg = JSON.parse(t);
        } catch {
          continue; // partial frame; wait for more
        }
        if (msg.id !== 1) continue;
        if (msg.error) {
          finish(false, `initialize returned error: ${JSON.stringify(msg.error)}`);
          return;
        }
        const v = msg.result?.protocolVersion;
        if (v === undefined) {
          finish(false, `initialize result missing protocolVersion: ${t.slice(0, 200)}`);
          return;
        }
        finish(true, `protocolVersion=${v}`);
        return;
      }
    });

    p.stderr.on("data", (d) => {
      stderr += d;
    });

    p.on("close", (code) => {
      finish(false, `container exited (code=${code}) before responding`);
    });

    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    };
    p.stdin.write(JSON.stringify(req) + "\n");
  });
}

async function main() {
  const opts = parseArgs(process.argv);

  const ping = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (ping.code !== 0) {
    warn("docker daemon is not reachable; cannot build or test images.");
    process.exit(1);
  }
  log(`docker server ${ping.out.trim()}`);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  let agents = manifest.agents.filter((a) => opts.all || a.enabled);
  if (opts.only) agents = agents.filter((a) => opts.only.has(a.id));

  if (agents.length === 0) {
    warn("no agents selected");
    process.exit(2);
  }
  log(`selected ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`);

  const results = [];
  for (const agent of agents) {
    const b = await build(agent, opts);
    if (!b.ok) {
      results.push({ id: agent.id, stage: "build", ok: false, detail: b.err.trim().split("\n").slice(-4).join(" | ") });
      if (!opts.keepGoing) break;
      continue;
    }
    if (!opts.smoke) {
      results.push({ id: agent.id, stage: "build", ok: true, detail: b.tag });
      continue;
    }
    log(`--- smoke ${agent.id}`);
    const s = await smoke(b.tag, agent.id);
    if (!s.ok) {
      warn(`smoke FAILED for ${agent.id}: ${s.reason}`);
      if (s.stderr.trim()) warn(s.stderr.trim().split("\n").slice(-15).join("\n"));
      results.push({ id: agent.id, stage: "smoke", ok: false, detail: s.reason });
      if (!opts.keepGoing) break;
      continue;
    }
    log(`smoke OK for ${agent.id}: ${s.reason}`);
    results.push({ id: agent.id, stage: "smoke", ok: true, detail: s.reason });
  }

  log("\n================ summary ================");
  for (const r of results) {
    log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(18)} ${r.stage.padEnd(6)} ${r.detail ?? ""}`);
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = agents.length - results.length;
  if (skipped > 0) log(`(${skipped} not attempted; re-run with --keep-going)`);
  log(`${results.length - failed.length}/${agents.length} passed`);
  process.exit(failed.length > 0 || skipped > 0 ? 1 : 0);
}

main().catch((e) => {
  warn(e);
  process.exit(1);
});
