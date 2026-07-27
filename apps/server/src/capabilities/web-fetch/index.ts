import type { FetchBackendId } from "@zakura/shared";
import {
  consumeManagedUsage,
  resolveManagedForFetchBackend,
} from "../../platform-services/runtime-bind.js";
import {
  mergeSlots,
  normalizeSlots,
  pickSlotRoundRobin,
  redactEngineMap,
  type CredSlotLike,
} from "../cred-slots.js";
import { getFetchBackend, listFetchBackendMeta } from "./backends.js";
import type {
  BackendRuntimeConfig,
  CredSlot,
  FetchResult,
  WebFetchConfig,
  WebFetchConfigPublic,
} from "./types.js";

export { listFetchBackendMeta, getFetchBackend };
export type {
  WebFetchConfig,
  WebFetchConfigPublic,
  FetchResult,
  CredSlot,
  BackendRuntimeConfig,
} from "./types.js";

export function enabledBackends(config: WebFetchConfig): FetchBackendId[] {
  const ids: FetchBackendId[] = [];
  for (const [id, cfg] of Object.entries(config.backends ?? {})) {
    if (!cfg?.enabled) continue;
    const slots = normalizeSlots(cfg);
    if (slots.length === 0 && cfg.enabled) {
      ids.push(id as FetchBackendId);
      continue;
    }
    if (slots.length > 0) ids.push(id as FetchBackendId);
  }
  return ids;
}

export function resolveBackendId(
  config: WebFetchConfig,
  requested?: string,
): FetchBackendId {
  const enabled = enabledBackends(config);
  if (!enabled.length) {
    throw new Error("未启用任何抓取后端，请先在「网页」中配置");
  }
  if (requested) {
    if (!enabled.includes(requested as FetchBackendId)) {
      throw new Error(`后端未启用: ${requested}`);
    }
    return requested as FetchBackendId;
  }
  if (config.defaultBackend && enabled.includes(config.defaultBackend)) {
    return config.defaultBackend;
  }
  return enabled[0]!;
}

export function redactWebFetchConfig(config: WebFetchConfig): WebFetchConfigPublic {
  return {
    defaultBackend: config.defaultBackend,
    backends: redactEngineMap(config.backends) as WebFetchConfigPublic["backends"],
  };
}

export function mergeWebFetchConfig(
  incoming: Record<string, unknown>,
  previous: WebFetchConfig | null,
): WebFetchConfig {
  const defaultBackend =
    typeof incoming.defaultBackend === "string"
      ? (incoming.defaultBackend as FetchBackendId)
      : previous?.defaultBackend;

  const inBackends =
    (incoming.backends as Record<string, BackendRuntimeConfig | undefined>) ?? {};
  const prevBackends = previous?.backends ?? {};
  const backends: WebFetchConfig["backends"] = {};

  const allIds = new Set([
    ...Object.keys(inBackends),
    ...Object.keys(prevBackends),
  ]);

  for (const id of allIds) {
    const backendId = id as FetchBackendId;
    const inc = inBackends[backendId];
    if (!inc) continue;
    const prev = prevBackends[backendId];
    const prevSlots = normalizeSlots(prev);
    let slots: CredSlotLike[];
    if (Array.isArray(inc.slots)) {
      slots = mergeSlots(inc.slots, prevSlots);
    } else {
      slots = mergeSlots(normalizeSlots(inc), prevSlots);
    }
    backends[backendId] = {
      enabled: Boolean(inc.enabled),
      slots: slots as CredSlot[],
    };
  }

  return { defaultBackend, backends };
}

export type WebFetchCallContext = {
  tenantId?: string;
  userId?: string | null;
};

export async function runWebFetch(
  config: WebFetchConfig,
  args: { url: string; backend?: string; timeoutMs?: number },
  ctx?: WebFetchCallContext,
): Promise<FetchResult & { managed?: boolean; slotId?: string }> {
  const url = args.url?.trim();
  if (!url) throw new Error("url is required");
  const backendId = resolveBackendId(config, args.backend);
  const backend = getFetchBackend(backendId);
  if (!backend) throw new Error(`Unknown backend: ${backendId}`);

  const beCfg = config.backends?.[backendId];
  let slots = normalizeSlots(beCfg);
  if (!slots.length && beCfg?.enabled) {
    slots = [{ id: "default" }];
  }
  const scope = `${ctx?.tenantId ?? "global"}:fetch:${backendId}`;
  const slot = pickSlotRoundRobin(scope, slots) ?? { id: "default" };

  const creds = {
    apiKey: slot.apiKey,
    baseUrl: slot.baseUrl,
  };

  let managed = false;
  const wantPlatform = Boolean(slot.usePlatform) || !creds.baseUrl?.trim();
  if (wantPlatform) {
    const resolved = await resolveManagedForFetchBackend(backendId);
    if (resolved) {
      const hadOverride = Boolean(creds.baseUrl?.trim()) && !slot.usePlatform;
      if (!creds.baseUrl?.trim() || slot.usePlatform) {
        creds.baseUrl = resolved.endpointUrl;
      }
      if (!creds.apiKey?.trim() && resolved.apiKey) {
        creds.apiKey = resolved.apiKey;
      }
      const base = creds.baseUrl?.replace(/\/$/, "") ?? "";
      const ep = resolved.endpointUrl.replace(/\/$/, "");
      managed = Boolean(base && (base === ep || base.startsWith(ep)));
      if (
        backendId === "jina-reader" &&
        !hadOverride &&
        !slot.usePlatform &&
        base.includes("r.jina.ai")
      ) {
        managed = false;
      }
      if (managed && ctx?.tenantId) {
        await consumeManagedUsage({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          serviceKey: resolved.serviceKey,
        });
      }
    }
  }

  const result = await backend.fetch(
    { url, timeoutMs: args.timeoutMs },
    { apiKey: creds.apiKey, baseUrl: creds.baseUrl },
  );
  return { ...result, managed, slotId: slot.id };
}
