console.log("write-diag");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const config = loadConfig();
const postgres = (await import("postgres")).default;

async function oneQuery(label, queryFn, ms = 8000) {
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

await oneQuery("current_timestamp", (sql) =>
  sql`SELECT CURRENT_TIMESTAMP AS t`.then((r) => r[0]),
);
await oneQuery("clock_timestamp", (sql) =>
  sql`SELECT clock_timestamp() AS t`.then((r) => r[0]),
);
await oneQuery("transaction_timestamp", (sql) =>
  sql`SELECT transaction_timestamp() AS t`.then((r) => r[0]),
);
await oneQuery("select_now_paren", (sql) =>
  sql.unsafe("SELECT now() AS t").then((r) => r[0]),
);
await oneQuery("count_packages", (sql) =>
  sql`SELECT count(*)::int AS n FROM integration_packages`.then((r) => r[0]),
  15000,
);
await oneQuery(
  "update_touch_one",
  async (sql) => {
    const rows = await sql`
      UPDATE integration_packages
      SET updated_at = updated_at
      WHERE slug = 'email-smtp'
      RETURNING slug
    `;
    return rows[0];
  },
  15000,
);
await oneQuery(
  "delete_not_in_empty",
  async (sql) => {
    // mirror sync's first statement shape without deleting real rows
    const rows = await sql`
      SELECT count(*)::int AS n FROM integration_packages
      WHERE slug NOT IN ('email-smtp')
    `;
    return rows[0];
  },
  15000,
);
console.log("done");
process.exit(0);
