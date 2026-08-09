console.log("ping-diag start");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const config = loadConfig();
const postgres = (await import("postgres")).default;
const sql = postgres(config.databaseUrl, {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
  max_lifetime: 10,
});
const timed = async (label, fn, ms = 8000) => {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
    ]);
    console.log(`[ok ${Date.now() - t0}ms] ${label}`, result);
  } catch (e) {
    console.log(`[fail ${Date.now() - t0}ms] ${label}:`, e instanceof Error ? e.message : e);
  }
};
try {
  await timed("select 1", async () => {
    const rows = await sql`SELECT 1 AS n`;
    return rows[0];
  });
  await timed("now()", async () => {
    const rows = await sql`SELECT now() AS t`;
    return rows[0];
  });
  await timed("count integration_packages", async () => {
    const rows = await sql`SELECT count(*)::int AS n FROM integration_packages`;
    return rows[0];
  }, 15000);
  await timed("count integration_components", async () => {
    const rows = await sql`SELECT count(*)::int AS n FROM integration_components`;
    return rows[0];
  }, 15000);
  await timed(
    "delete dry-run explain",
    async () => {
      const rows = await sql`
        EXPLAIN SELECT 1 FROM integration_packages
        WHERE slug NOT IN ('x') LIMIT 1
      `;
      return rows.map((r) => r["QUERY PLAN"]).join(" | ");
    },
    10000,
  );
} finally {
  await sql.end({ timeout: 2 });
  console.log("done");
}
