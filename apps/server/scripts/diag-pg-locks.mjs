console.log("lock-diag start");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const config = loadConfig();
console.log("config ok, connecting…");
const postgres = (await import("postgres")).default;
const sql = postgres(config.databaseUrl, {
  max: 1,
  connect_timeout: 5,
  connection: { statement_timeout: 5000 },
});
try {
  console.log("connected, querying activity…");
  const rows = await sql`
    SELECT pid, state, wait_event_type, wait_event,
           EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s,
           EXTRACT(EPOCH FROM (now() - xact_start))::int AS xact_age_s,
           left(query, 200) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
    ORDER BY xact_start NULLS LAST
  `;
  console.log(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? Number(v) : v), 2));
} catch (e) {
  console.error("query failed:", e);
} finally {
  await sql.end({ timeout: 2 });
  console.log("done");
}
