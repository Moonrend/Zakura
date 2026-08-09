console.log("fresh-conn diag");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const config = loadConfig();
const postgres = (await import("postgres")).default;

async function oneQuery(label, queryFn, ms = 5000) {
  const sql = postgres(config.databaseUrl, { max: 1, connect_timeout: 5 });
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      queryFn(sql),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
    ]);
    console.log(`[ok ${Date.now() - t0}ms] ${label}`, result);
  } catch (e) {
    console.log(`[fail ${Date.now() - t0}ms] ${label}:`, e instanceof Error ? e.message : e);
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}

await oneQuery("select1", (sql) => sql`SELECT 1 AS n`.then((r) => r[0]));
await oneQuery("select2", (sql) => sql`SELECT 2 AS n`.then((r) => r[0]));
await oneQuery("now", (sql) => sql`SELECT now() AS t`.then((r) => r[0]));
await oneQuery(
  "pg_is_in_recovery",
  (sql) => sql`SELECT pg_is_in_recovery() AS r`.then((r) => r[0]),
);
await oneQuery(
  "activity_count",
  (sql) =>
    sql`SELECT count(*)::int AS n FROM pg_stat_activity`.then((r) => r[0]),
  10000,
);
await oneQuery(
  "integration_packages_limit1",
  (sql) => sql`SELECT slug FROM integration_packages LIMIT 1`.then((r) => r[0]),
  10000,
);
console.log("done");
process.exit(0);
