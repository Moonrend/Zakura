#!/usr/bin/env node
/**
 * Build a container manifest from the upstream ACP registry.
 *
 * Reads the registry index (remote by default, or a local file via --registry)
 * and emits scripts/acp-images.json, which is the single source of truth for:
 *   - the GitHub Actions build matrix
 *   - local smoke testing (scripts/acp-image-smoke.mjs)
 *   - CONTAINER_SOURCES in packages/shared/src/acp-sources.ts
 *
 * Every agent in the registry gets an entry. Whether we actually build it is
 * decided by `enabled`, which is opt-in per profile so a broken upstream
 * release can never take down the whole matrix.
 *
 * Usage:
 *   node scripts/acp-build-manifest.mjs [--registry <url|path>] [--out <path>] [--check]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

// Only these profiles are built. Adding a line here is the entire opt-in.
// Keep this list conservative: each entry must have passed a local smoke test.
const ENABLED = new Set([
  "claude-acp",
  "gemini",
  "qwen-code",
  "opencode",
  "goose",
]);

// linux/amd64 is the only architecture the registry guarantees for every agent.
const PLATFORM_KEY = "linux-x86_64";

function parseArgs(argv) {
  const out = { registry: REGISTRY_URL, out: null, check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--registry") out.registry = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--check") out.check = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  out.out ??= resolve(REPO, "scripts/acp-images.json");
  return out;
}

async function loadRegistry(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`registry fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }
  return JSON.parse(readFileSync(resolve(REPO, source), "utf8"));
}

/**
 * Normalise one registry agent into a build spec.
 *
 * The registry has three distribution kinds and each needs a different
 * install strategy inside the image:
 *   npx    -> npm i -g <package>          (node base)
 *   uvx    -> uv tool install <package>   (node base + uv)
 *   binary -> download + extract archive  (glibc base; upstream binaries are
 *                                          x86_64-unknown-linux-gnu, so musl
 *                                          bases like alpine will NOT work)
 */
function toSpec(agent) {
  const dist = agent.distribution ?? {};
  const base = {
    id: agent.id,
    name: agent.name ?? agent.id,
    version: agent.version ?? null,
    enabled: ENABLED.has(agent.id),
  };

  if (dist.npx) {
    return {
      ...base,
      kind: "npx",
      package: dist.npx.package,
      args: dist.npx.args ?? [],
      env: dist.npx.env ?? {},
    };
  }

  if (dist.uvx) {
    return {
      ...base,
      kind: "uvx",
      package: dist.uvx.package,
      args: dist.uvx.args ?? [],
      env: dist.uvx.env ?? {},
    };
  }

  if (dist.binary) {
    const entry = dist.binary[PLATFORM_KEY];
    if (!entry) {
      return { ...base, kind: "unsupported", reason: `no ${PLATFORM_KEY} build` };
    }
    return {
      ...base,
      kind: "binary",
      archive: entry.archive,
      sha256: entry.sha256 ?? null,
      cmd: entry.cmd,
      args: entry.args ?? [],
      env: entry.env ?? {},
    };
  }

  return { ...base, kind: "unsupported", reason: "no known distribution" };
}

const args = parseArgs(process.argv);
const registry = await loadRegistry(args.registry);

const agents = Array.isArray(registry.agents) ? registry.agents : [];
if (agents.length === 0) throw new Error("registry contained no agents");

const specs = agents
  .map(toSpec)
  .sort((a, b) => a.id.localeCompare(b.id));

// Fail loudly if an opted-in profile vanished upstream or lost its linux build,
// rather than silently shrinking the build matrix.
for (const id of ENABLED) {
  const spec = specs.find((s) => s.id === id);
  if (!spec) throw new Error(`enabled profile "${id}" is missing from registry`);
  if (spec.kind === "unsupported") {
    throw new Error(`enabled profile "${id}" is unsupported: ${spec.reason}`);
  }
}

const manifest = {
  // Not the registry's own version: this is our manifest schema version.
  schema: 1,
  generatedFrom: args.registry,
  registryVersion: registry.version ?? null,
  platform: "linux/amd64",
  agents: specs,
};

const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

if (args.check) {
  if (!existsSync(args.out)) {
    console.error(`missing ${args.out}; run without --check to generate it`);
    process.exit(1);
  }
  const current = readFileSync(args.out, "utf8");
  // Ignore generatedFrom/registryVersion drift: we only care that the set of
  // agents and their install specs still match.
  const norm = (raw) => JSON.stringify(JSON.parse(raw).agents);
  if (norm(current) !== JSON.stringify(manifest.agents)) {
    console.error("acp-images.json is out of date; regenerate it");
    process.exit(1);
  }
  console.log("acp-images.json is up to date");
  process.exit(0);
}

writeFileSync(args.out, serialised);

const enabled = specs.filter((s) => s.enabled);
const byKind = specs.reduce((acc, s) => {
  acc[s.kind] = (acc[s.kind] ?? 0) + 1;
  return acc;
}, {});
console.log(`wrote ${args.out}`);
console.log(`  registry version: ${manifest.registryVersion ?? "(none)"}`);
console.log(`  agents: ${specs.length} ${JSON.stringify(byKind)}`);
console.log(`  enabled: ${enabled.length} -> ${enabled.map((s) => s.id).join(", ")}`);