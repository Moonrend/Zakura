// Regenerates internal/runtime/acp_catalog.json from the built @zakura/shared
// package, so the Go server serves the same ACP profile catalog and registry
// index as the web client. Run after `pnpm acp:sync-registry` and a shared build:
//
//   node apps/server/scripts/gen-acp-catalog.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "..", "packages", "shared", "dist");
const { builtinAcpProfiles } = await import(pathToFileURL(join(shared, "acp.js")).href);
const { acpRegistryIndex } = await import(pathToFileURL(join(shared, "acp-registry-client.js")).href);

const index = acpRegistryIndex();
const catalog = {
  digest: index.digest,
  imagePrefix: index.imagePrefix,
  profiles: builtinAcpProfiles(),
  agents: index.agents,
};
const out = join(here, "..", "internal", "runtime", "acp_catalog.json");
writeFileSync(out, `${JSON.stringify(catalog, null, 1)}\n`);
console.log(`wrote ${catalog.profiles.length} profiles, ${catalog.agents.length} registry agents -> ${out}`);
