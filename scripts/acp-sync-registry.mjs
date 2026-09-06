#!/usr/bin/env node
/**
 * Refreshes the vendored registry snapshot from Moonrend/acp-registry.
 *
 * The snapshot is committed so builds are hermetic and the app works offline;
 * this script is how it gets updated. Run: pnpm acp:sync-registry
 *
 * ZAKURA_ACP_REGISTRY_URL accepts an https URL or a local path, so a registry
 * checkout can be synced directly:
 *   ZAKURA_ACP_REGISTRY_URL=../acp-registry/dist/index.json pnpm acp:sync-registry
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "../packages/shared/src/acp-registry-snapshot.ts");
const SOURCE =
  process.env.ZAKURA_ACP_REGISTRY_URL ??
  "https://raw.githubusercontent.com/Moonrend/acp-registry/main/dist/index.json";

const CHECK = process.argv.includes("--check");

const index = await load(SOURCE);

async function load(source) {
  if (!/^https?:/.test(source)) {
    const file = path.resolve(source.replace(/^file:\/\//, ""));
    if (!fs.existsSync(file)) {
      console.error(`registry index not found: ${file}`);
      process.exit(2);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  // raw.githubusercontent.com sits behind a 5-minute varnish cache, so a plain
  // fetch right after a push can return the previous index. Bust it explicitly
  // rather than silently snapshotting a stale digest.
  const url = `${source}${source.includes("?") ? "&" : "?"}ts=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!res.ok) {
    console.error(`failed to fetch registry index: HTTP ${res.status}`);
    process.exit(2);
  }
  return res.json();
}

if (!Array.isArray(index.agents) || index.agents.length === 0) {
  console.error("registry index is empty or malformed; refusing to write");
  process.exit(2);
}

const contents = `// GENERATED FILE - DO NOT EDIT.
// Snapshot of Moonrend/acp-registry dist/index.json.
// Refresh with: pnpm acp:sync-registry
import type { AcpCuratedIndex } from "./acp-registry-client.js";

export const ACP_REGISTRY_SNAPSHOT = ${JSON.stringify(index, null, 2)} as AcpCuratedIndex;
`;

const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
if (current === contents) {
  console.log(`✓ snapshot up to date (${index.agents.length} agents, digest ${index.digest})`);
  process.exit(0);
}

if (CHECK) {
  console.error(`✗ snapshot is stale — run: pnpm acp:sync-registry`);
  process.exit(1);
}

fs.writeFileSync(OUT, contents);
console.log(`updated snapshot: ${index.agents.length} agents, digest ${index.digest}`);
