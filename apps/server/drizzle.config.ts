import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

/**
 * Single PostgreSQL dialect config.
 * Same migrations apply to PGlite (embedded) and remote Postgres.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL && /^postgres/i.test(process.env.DATABASE_URL)
        ? process.env.DATABASE_URL
        : "postgresql://zakura:zakura@127.0.0.1:5432/zakura",
  },
  strict: true,
  verbose: true,
});
