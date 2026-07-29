import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

/**
 * PGlite，预装 pgvector（内置语义记忆）与 pg_trgm（会话标题模糊搜索）。
 * 两个扩展都在这里装好，嵌入式部署才能拿到跟远程 Postgres 一样的搜索能力。
 */
export async function createPglite(dataDir: string): Promise<PGlite> {
  mkdirSync(dirname(dataDir), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir, {
    extensions: { vector, pg_trgm },
  });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  return client;
}
