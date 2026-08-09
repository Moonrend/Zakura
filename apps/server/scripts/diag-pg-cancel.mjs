console.log("kill-stuck diag");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const config = loadConfig();
const postgres = (await import("postgres")).default;
const sql = postgres(config.databaseUrl, { max: 1, connect_timeout: 5 });

const timed = (p, ms = 5000) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);

try {
  const pid = await timed(sql`SELECT pg_backend_pid() AS pid`.then((r) => r[0].pid));
  console.log("my pid", pid);
} catch (e) {
  console.log("pid query failed", e instanceof Error ? e.message : e);
}

// Try lightweight activity without joins
try {
  const rows = await timed(
    sql.unsafe(`
      SELECT pid, state, wait_event_type, wait_event,
             left(query, 120) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
      LIMIT 30
    `),
    8000,
  );
  console.log("activity", JSON.stringify(rows, null, 2));
} catch (e) {
  console.log("activity failed", e instanceof Error ? e.message : e);
}

// Cancel other backends' queries (not terminate) if we can
try {
  const cancelled = await timed(
    sql.unsafe(`
      SELECT pid, pg_cancel_backend(pid) AS cancelled
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
        AND query NOT ILIKE '%pg_stat_activity%'
    `),
    8000,
  );
  console.log("cancelled", JSON.stringify(cancelled, null, 2));
} catch (e) {
  console.log("cancel failed", e instanceof Error ? e.message : e);
}

await sql.end({ timeout: 2 });
console.log("done");
