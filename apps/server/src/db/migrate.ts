import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { resolveDbKind } from "./client.js";
import { createPglite } from "./pglite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = resolve(root, "drizzle");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const kind = resolveDbKind(databaseUrl);
  console.log(`[db] migrate kind=${kind}`);

  if (kind === "pglite") {
    let dir = databaseUrl.replace(/^pglite:/i, "").replace(/^file:/i, "");
    if (!dir || dir === ":memory:") {
      dir = resolve(root, "../../data/pglite");
    } else {
      dir = resolve(dir);
    }
    mkdirSync(dir, { recursive: true });
    const client = await createPglite(dir);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
    await client.close();
  } else {
    const sql = postgres(databaseUrl, { max: 1 });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`.catch((err) => {
      console.warn("[db] CREATE EXTENSION vector:", err);
    });
    // 会话标题模糊搜索用；装不上（托管库未提供 / 权限不足）时搜索自动回退 ILIKE
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.catch((err) => {
      console.warn("[db] CREATE EXTENSION pg_trgm（会话搜索将回退 ILIKE）:", err);
    });
    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder });
    await sql.end({ timeout: 5 });
  }

  console.log("[db] migrate ok");
}

const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isCli) {
  const databaseUrl =
    process.env.DATABASE_URL ?? `pglite:${resolve(root, "../../data/pglite")}`;
  runMigrations(databaseUrl).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
