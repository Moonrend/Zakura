import { runMigrations } from './src/db/migrate.ts';
import { createDb } from './src/db/client.ts';
import { ExposureService, reconcileOrphanExposures, serializeExposure } from './src/services/port-exposures.ts';
import { portExposures, tenants, agents, newId } from './src/db/schema.ts';

const url = 'pglite:D:/github/reCloud/data/pglite-debug-exposure2';
await runMigrations(url);
const { db, close } = await createDb({ databaseUrl: url, dataDir: 'D:/github/reCloud/data' });
console.log('migrate+db ok');
const n = await reconcileOrphanExposures(db);
console.log('orphans', n);

const now = new Date();
const tenantId = newId();
const agentId = newId();
await db.insert(tenants).values({ id: tenantId, slug: 't', name: 'T', createdAt: now, updatedAt: now });
await db.insert(agents).values({ id: agentId, tenantId, slug: 'a', name: 'A', createdAt: now, updatedAt: now } as any);
await db.insert(portExposures).values({
  id: newId(), tenantId, agentId, port: 3000, protocol: 'http', provider: 'cloudflare-quick',
  status: 'active', publicUrl: 'https://x.trycloudflare.com', ttlMinutes: 60,
  expiresAt: new Date(Date.now() + 3600000), createdAt: now, updatedAt: now,
});

const fake: any = { ensureTenantDefaults: async () => {} };
const security: any = {};
const audit: any = { append: async () => {} };
const svc = new ExposureService(db, {} as any, {} as any, {} as any, fake, security, audit);
const items = await svc.listActive(tenantId);
console.log('listActive', JSON.stringify(items, null, 2));
await close();
