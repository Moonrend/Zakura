import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

/**
 * Minimal .env loader (no dependency). Does not override existing process.env.
 * Loads repo root then apps/server so local overrides win.
 */
export function loadEnvFiles(files?: string[]) {
  const paths =
    files ??
    [
      resolve(repoRoot, ".env"),
      resolve(repoRoot, ".env.local"),
      resolve(packageRoot, ".env"),
      resolve(packageRoot, ".env.local"),
    ];

  for (const file of paths) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      // empty shell/compose placeholders must not block .env
      if (key in process.env && (process.env[key] ?? "").trim() !== "") continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
