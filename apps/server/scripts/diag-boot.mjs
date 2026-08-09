console.log("boot-diag start");
process.env.REDIS_URL = process.env.REDIS_URL || "off";
const t0 = Date.now();
const log = (m) => console.log(`[+${Date.now() - t0}ms] ${m}`);

async function go() {
  log("import config");
  const { loadConfig } = await import("../src/config.ts");
  const config = loadConfig();
  log(`db=${/^postgres/i.test(config.databaseUrl) ? "postgres" : "other"}`);
  log("migrate");
  const { runMigrations } = await import("../src/db/migrate.ts");
  await runMigrations(config.databaseUrl);
  log("createDb");
  const { createDb } = await import("../src/db/client.ts");
  const { db } = await createDb({
    databaseUrl: config.databaseUrl,
    dataDir: config.dataDir,
  });
  log("providers");
  const { bindProviderRuntime, registerBuiltinProviders } = await import(
    "../src/providers/index.ts"
  );
  const { registerBuiltinModelAdapters } = await import("../src/model-router/index.ts");
  registerBuiltinProviders();
  registerBuiltinModelAdapters();
  bindProviderRuntime(db, config);
  log("catalog.sync begin");
  const { IntegrationCatalogService } = await import("../src/services/integration-catalog.ts");
  const cat = new IntegrationCatalogService(db, config);
  const syncTimer = setTimeout(() => log("catalog.sync still running after 8s"), 8000);
  await cat.sync();
  clearTimeout(syncTimer);
  log("catalog.sync done");
  process.exit(0);
}

go().catch((e) => {
  console.error(e);
  process.exit(1);
});
