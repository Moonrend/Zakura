/**
 * Single source of truth for the Runner Agent version.
 *
 * Resolution order:
 *   1. ZAKURA_RUNNER_VERSION env override (set at build/run by Dockerfile)
 *   2. the `version` field of this package's package.json (resolved relative to
 *      the compiled source so it works under both tsx dev and built dist)
 *   3. a hard fallback constant
 *
 * Exported so index.ts / app.ts / server-sync.ts share one value.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0-unknown";

let cached: string | undefined;

export function resolveRunnerVersion(): string {
  if (cached) return cached;

  const fromEnv = process.env.ZAKURA_RUNNER_VERSION?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/version.ts → ../package.json (dev) ; dist/version.js → ../package.json
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) {
      cached = pkg.version;
      return cached;
    }
  } catch {
    /* fall through to fallback */
  }

  cached = FALLBACK_VERSION;
  return cached;
}
