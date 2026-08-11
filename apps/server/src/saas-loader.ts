import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ZakuraEdition } from "@zakura/shared";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const SAAS_PACKAGE = "@zakura/saas";
const SAAS_SERVER_SPEC = "@zakura/saas/server";

/** Duck type — avoids a hard compile-time dependency after `pnpm strip:saas`. */
export type SaasServerModule = {
  registerSaasRoutes: (app: unknown, deps: unknown) => void;
  listPublicOauthProviders?: (deps: unknown) => Promise<
    Array<{ id: string; name: string; enabled: boolean }>
  >;
  loadLoginPolicy?: (deps: unknown) => Promise<{
    effective: { disablePasswordLogin: boolean };
  }>;
  /** @deprecated Prefer listPublicOauthProviders + loadLoginPolicy */
  loadZerocatConfig?: (deps: unknown) => Promise<{
    public: { enabled: boolean; disablePasswordLogin?: boolean };
  }>;
  SAAS_SERVER_MODULE?: string;
};

/**
 * Whether `@zakura/saas` is installed.
 * Avoid CJS-only `require.resolve` on `"import"`-only export maps (that was
 * silently failing and forcing edition back to oss).
 */
export function isSaasPackagePresent(): boolean {
  // 1) ESM resolve (Node 20+)
  try {
    const resolved = import.meta.resolve?.(SAAS_SERVER_SPEC);
    if (resolved) return true;
  } catch {
    /* continue */
  }

  // 2) Package root via createRequire (main export / package.json)
  try {
    const pkgJson = require.resolve(`${SAAS_PACKAGE}/package.json`);
    if (existsSync(pkgJson)) return true;
  } catch {
    /* continue */
  }

  try {
    const pkgRoot = dirname(require.resolve(`${SAAS_PACKAGE}/package.json`));
    if (existsSync(join(pkgRoot, "dist", "server", "index.js"))) return true;
  } catch {
    /* continue */
  }

  // 3) Monorepo source checkout (dev before publish)
  const monorepoDist = join(here, "../../../packages/saas/dist/server/index.js");
  const monorepoSrc = join(here, "../../../packages/saas/src/server/index.ts");
  if (existsSync(monorepoDist) || existsSync(monorepoSrc)) return true;

  return false;
}

/**
 * Resolve deployment edition from `ZAKURA_EDITION=oss|saas`.
 * Falls back to oss when the saas package was stripped.
 */
export function resolveEdition(): ZakuraEdition {
  const explicit = (process.env.ZAKURA_EDITION ?? "").trim().toLowerCase();
  if (explicit !== "saas") return "oss";

  if (!isSaasPackagePresent()) {
    console.warn(
      "[config] SaaS edition requested but @zakura/saas is not installed; falling back to oss",
    );
    return "oss";
  }
  return "saas";
}

/** Absolute filesystem paths must be file:// URLs for ESM import() on Windows. */
function toImportSpecifier(spec: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith("\\\\") || spec.startsWith("/")) {
    return pathToFileURL(spec).href;
  }
  return spec;
}

/** Dynamic import via indirection so stripped OSS trees still typecheck. */
export async function loadSaasServer(): Promise<SaasServerModule | null> {
  if (resolveEdition() !== "saas") return null;
  if (!isSaasPackagePresent()) return null;

  const candidates = [SAAS_SERVER_SPEC];
  const monorepoDist = join(here, "../../../packages/saas/dist/server/index.js");
  if (existsSync(monorepoDist)) {
    candidates.push(monorepoDist);
  }

  const dynamicImport = new Function("s", "return import(s)") as (
    s: string,
  ) => Promise<SaasServerModule>;

  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      return await dynamicImport(toImportSpecifier(spec));
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn("[saas] failed to load @zakura/saas/server:", lastErr);
  return null;
}
