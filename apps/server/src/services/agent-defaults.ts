import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, newId, settings, tenantMemberships } from "../db/schema.js";
import { ensureCapabilityInstance } from "./capabilities.js";
import type { Orchestrator } from "./orchestrator.js";
import { parseAgentConfig, type AgentConfigBag } from "./agent-providers.js";

export const AGENT_DEFAULTS_KEY = "agents.web-defaults";

export type AgentWebDefaults = {
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  searchEngine: string | null;
  fetchBackend: string | null;
  autoManagedServices: string[];
};

export const DEFAULT_AGENT_WEB_DEFAULTS: AgentWebDefaults = {
  webSearchEnabled: true,
  webFetchEnabled: true,
  searchEngine: null,
  fetchBackend: null,
  autoManagedServices: [],
};

function normalize(value: unknown): AgentWebDefaults {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    webSearchEnabled: raw.webSearchEnabled !== false,
    webFetchEnabled: raw.webFetchEnabled !== false,
    searchEngine: typeof raw.searchEngine === "string" && raw.searchEngine ? raw.searchEngine : null,
    fetchBackend: typeof raw.fetchBackend === "string" && raw.fetchBackend ? raw.fetchBackend : null,
    autoManagedServices: Array.isArray(raw.autoManagedServices)
      ? raw.autoManagedServices.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [],
  };
}

export async function getAgentWebDefaults(db: Db): Promise<AgentWebDefaults> {
  const row = await db.query.settings.findFirst({
    where: and(eq(settings.ownerKey, "platform"), eq(settings.key, AGENT_DEFAULTS_KEY)),
  });
  if (!row) return DEFAULT_AGENT_WEB_DEFAULTS;
  try {
    return normalize(JSON.parse(row.value));
  } catch {
    return DEFAULT_AGENT_WEB_DEFAULTS;
  }
}

export async function saveAgentWebDefaults(db: Db, value: Partial<AgentWebDefaults>) {
  const next = { ...(await getAgentWebDefaults(db)), ...value };
  const normalized = normalize(next);
  const [row] = await db
    .insert(settings)
    .values({
      id: newId(),
      ownerKey: "platform",
      key: AGENT_DEFAULTS_KEY,
      value: JSON.stringify(normalized),
    })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value: JSON.stringify(normalized) },
    })
    .returning();
  return row ? normalized : normalized;
}

/** Undefined agent values inherit platform defaults; explicit false/values remain overrides. */
export function effectiveAgentWebDefaults(
  config: AgentConfigBag,
  platform: AgentWebDefaults,
) {
  return {
    webSearchEnabled: config.providers?.webSearch?.enabled ?? platform.webSearchEnabled,
    webFetchEnabled: config.providers?.webFetch?.enabled ?? platform.webFetchEnabled,
    searchEngine: config.providers?.webSearch?.defaultEngine ?? platform.searchEngine,
    fetchBackend: config.providers?.webFetch?.defaultBackend ?? platform.fetchBackend,
  };
}

export async function enableWebForUserAgents(
  db: Db,
  orchestrator: Orchestrator,
  userId: string,
) {
  const memberships = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, "active")));
  let updated = 0;
  for (const membership of memberships) {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, membership.tenantId));
    for (const agent of rows) {
      const bag = parseAgentConfig(agent);
      const providers = {
        ...bag.providers,
        webSearch: { ...bag.providers?.webSearch, enabled: true },
        webFetch: { ...bag.providers?.webFetch, enabled: true },
      };
      await db
        .update(agents)
        .set({ configJson: JSON.stringify({ ...bag, providers }), updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
      updated += 1;
    }
    await ensureCapabilityInstance(db, orchestrator, membership.tenantId, "web-search", { start: true });
    await ensureCapabilityInstance(db, orchestrator, membership.tenantId, "web-fetch", { start: true });
  }
  return { updated, tenants: memberships.length };
}
