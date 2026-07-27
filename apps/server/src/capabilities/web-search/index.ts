import type { SearchEngineId } from "@zakura/shared";
import {
  consumeManagedUsage,
  resolveManagedForSearchEngine,
} from "../../platform-services/runtime-bind.js";
import {
  mergeSlots,
  normalizeSlots,
  pickSlotRoundRobin,
  redactEngineMap,
  type CredSlotLike,
} from "../cred-slots.js";
import { getSearchEngine, listSearchEngineMeta } from "./engines.js";
import type {
  CredSlot,
  EngineRuntimeConfig,
  SearchHit,
  WebSearchConfig,
  WebSearchConfigPublic,
} from "./types.js";

export { listSearchEngineMeta, getSearchEngine };
export { normalizeSlots } from "../cred-slots.js";
export type {
  WebSearchConfig,
  WebSearchConfigPublic,
  SearchHit,
  CredSlot,
  EngineRuntimeConfig,
} from "./types.js";

export function secretExtraKeysForEngine(engineId: string): string[] {
  // Currently no secret extra fields; cx/pid/folderId are non-secret ids.
  void engineId;
  return [];
}

export function enabledEngines(config: WebSearchConfig): SearchEngineId[] {
  const ids: SearchEngineId[] = [];
  for (const [id, cfg] of Object.entries(config.engines ?? {})) {
    if (!cfg?.enabled) continue;
    const slots = normalizeSlots(cfg);
    // Enabled with empty slots is ok for engines that need no creds (duckduckgo)
    // or platform-only; keep them listed.
    if (slots.length === 0 && cfg.enabled) {
      ids.push(id as SearchEngineId);
      continue;
    }
    if (slots.length > 0) ids.push(id as SearchEngineId);
  }
  return ids;
}

export function resolveEngineId(
  config: WebSearchConfig,
  requested?: string,
): SearchEngineId {
  const enabled = enabledEngines(config);
  if (!enabled.length) {
    throw new Error("未启用任何搜索引擎，请先在「网页」中配置");
  }
  if (requested) {
    if (!enabled.includes(requested as SearchEngineId)) {
      throw new Error(`引擎未启用: ${requested}`);
    }
    return requested as SearchEngineId;
  }
  if (config.defaultEngine && enabled.includes(config.defaultEngine)) {
    return config.defaultEngine;
  }
  return enabled[0]!;
}

export function redactWebSearchConfig(config: WebSearchConfig): WebSearchConfigPublic {
  return {
    defaultEngine: config.defaultEngine,
    engines: redactEngineMap(config.engines, secretExtraKeysForEngine) as WebSearchConfigPublic["engines"],
  };
}

/** Merge client body with previous secrets; always store slots form. */
export function mergeWebSearchConfig(
  incoming: Record<string, unknown>,
  previous: WebSearchConfig | null,
): WebSearchConfig {
  const defaultEngine =
    typeof incoming.defaultEngine === "string"
      ? (incoming.defaultEngine as SearchEngineId)
      : previous?.defaultEngine;

  const inEngines =
    (incoming.engines as Record<string, EngineRuntimeConfig | undefined>) ?? {};
  const prevEngines = previous?.engines ?? {};
  const engines: WebSearchConfig["engines"] = {};

  const allIds = new Set([
    ...Object.keys(inEngines),
    ...Object.keys(prevEngines),
  ]);

  for (const id of allIds) {
    const engineId = id as SearchEngineId;
    const inc = inEngines[engineId];
    if (!inc) continue; // removed
    const prev = prevEngines[engineId];
    const prevSlots = normalizeSlots(prev);
    let slots: CredSlotLike[];
    if (Array.isArray(inc.slots)) {
      slots = mergeSlots(inc.slots, prevSlots, secretExtraKeysForEngine(engineId));
    } else {
      // legacy form from older clients
      slots = mergeSlots(
        normalizeSlots(inc),
        prevSlots,
        secretExtraKeysForEngine(engineId),
      );
    }
    engines[engineId] = {
      enabled: Boolean(inc.enabled),
      slots: slots as CredSlot[],
    };
  }

  return { defaultEngine, engines };
}

export type WebSearchCallContext = {
  tenantId?: string;
  userId?: string | null;
};

export async function runWebSearch(
  config: WebSearchConfig,
  args: { query: string; engine?: string; limit?: number; language?: string },
  ctx?: WebSearchCallContext,
): Promise<{ engine: SearchEngineId; results: SearchHit[]; managed?: boolean; slotId?: string }> {
  const query = args.query?.trim();
  if (!query) throw new Error("query is required");

  const engineId = resolveEngineId(config, args.engine);
  const engine = getSearchEngine(engineId);
  if (!engine) throw new Error(`Unknown engine: ${engineId}`);

  const engCfg = config.engines?.[engineId];
  let slots = normalizeSlots(engCfg);
  // Zero-config free engines (duckduckgo) may have enabled=true with no slots
  if (!slots.length && engCfg?.enabled) {
    slots = [{ id: "default" }];
  }
  const scope = `${ctx?.tenantId ?? "global"}:search:${engineId}`;
  const slot = pickSlotRoundRobin(scope, slots) ?? { id: "default" };

  const creds = {
    apiKey: slot.apiKey,
    baseUrl: slot.baseUrl,
    extra: slot.extra,
  };

  let managed = false;
  const wantPlatform = Boolean(slot.usePlatform) || !creds.baseUrl?.trim();
  if (wantPlatform) {
    const resolved = await resolveManagedForSearchEngine(engineId);
    if (resolved) {
      if (!creds.baseUrl?.trim() || slot.usePlatform) {
        creds.baseUrl = resolved.endpointUrl;
      }
      if (!creds.apiKey?.trim() && resolved.apiKey) {
        creds.apiKey = resolved.apiKey;
      }
      const base = creds.baseUrl?.replace(/\/$/, "") ?? "";
      const ep = resolved.endpointUrl.replace(/\/$/, "");
      managed = Boolean(base && (base === ep || base.startsWith(ep)));
      if (managed && ctx?.tenantId) {
        await consumeManagedUsage({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          serviceKey: resolved.serviceKey,
        });
      }
    }
  }

  const results = await engine.search(
    { query, limit: args.limit, language: args.language },
    {
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      extra: creds.extra,
    },
  );
  return { engine: engineId, results, managed, slotId: slot.id };
}
