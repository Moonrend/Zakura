import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { createPglite } from "./pglite.js";

export type Db =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePg<typeof schema>>;

export type DbKind = "pglite" | "postgres";

export interface DbHandle {
  db: Db;
  kind: DbKind;
  /** Close underlying connections */
  close: () => Promise<void>;
}

/**
 * One schema (PostgreSQL dialect). Two runtimes:
 * - pglite  → self-host, zero external DB (default) — with pgvector
 * - postgres → cloud / multi-tenant / compose — requires CREATE EXTENSION vector
 *
 * DATABASE_URL:
 * - unset | `pglite:` | `pglite:./path` | `file:./path` → PGlite under data dir
 * - `postgresql://...` | `postgres://...` → remote Postgres
 */
export function resolveDbKind(databaseUrl: string): DbKind {
  const url = databaseUrl.trim();
  if (!url || url.startsWith("pglite:") || url.startsWith("file:")) {
    return "pglite";
  }
  if (/^postgres(ql)?:\/\//i.test(url)) {
    return "postgres";
  }
  throw new Error(
    `Unsupported DATABASE_URL. Use pglite:/path, file:/path, or postgresql://... Got: ${url.slice(0, 48)}`,
  );
}

function pgliteDataDir(databaseUrl: string, fallbackDataDir: string): string {
  const url = databaseUrl.trim();
  if (url.startsWith("pglite:") || url.startsWith("file:")) {
    const raw = url.replace(/^(pglite|file):/i, "");
    if (raw && raw !== ":memory:") {
      return resolve(raw.replace(/^\/\//, ""));
    }
  }
  return resolve(fallbackDataDir, "pglite");
}

export async function createDb(opts: {
  databaseUrl: string;
  dataDir: string;
}): Promise<DbHandle> {
  const kind = resolveDbKind(opts.databaseUrl);

  if (kind === "pglite") {
    const dir = pgliteDataDir(opts.databaseUrl, opts.dataDir);
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const client = await createPglite(dir);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind,
      close: async () => {
        await client.close();
      },
    };
  }

  const sql = postgres(opts.databaseUrl, { max: 10 });
  // Ensure pgvector is available on managed Postgres (no-op if already installed)
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.catch((err) => {
    console.warn("[db] CREATE EXTENSION vector failed (need superuser?):", err);
  });
  const db = drizzlePg(sql, { schema });
  return {
    db,
    kind,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };
