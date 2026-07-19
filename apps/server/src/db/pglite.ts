import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

/** PGlite with pgvector extension loaded (required for Built-in semantic memory). */
export async function createPglite(dataDir: string): Promise<PGlite> {
  mkdirSync(dirname(dataDir), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir, {
    extensions: { vector },
  });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  return client;
}
