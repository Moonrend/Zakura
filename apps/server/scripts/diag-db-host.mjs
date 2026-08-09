process.env.REDIS_URL = process.env.REDIS_URL || "off";
const { loadConfig } = await import("../src/config.ts");
const c = loadConfig();
const raw = c.databaseUrl.replace(/^postgres(ql)?:\/\//i, "http://");
try {
  const x = new URL(raw);
  console.log(`host=${x.hostname} port=${x.port || 5432} db=${x.pathname}`);
} catch (e) {
  console.log("parse fail", e instanceof Error ? e.message : e);
}
console.log(
  "markers",
  JSON.stringify({
    pooler: /pooler|pgbouncer/i.test(c.databaseUrl),
    neon: /neon\.tech/i.test(c.databaseUrl),
    supabase: /supabase/i.test(c.databaseUrl),
    localhost: /localhost|127\.0\.0\.1/i.test(c.databaseUrl),
  }),
);
