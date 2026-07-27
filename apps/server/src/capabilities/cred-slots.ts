/**
 * Shared multi-slot credential helpers for web-search / web-fetch.
 * Slots enable round-robin across API keys or endpoints of the same provider.
 */

export type CredSlotLike = {
  id: string;
  label?: string;
  usePlatform?: boolean;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
};

export type LegacyCreds = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
  slots?: CredSlotLike[];
};

const rrCounters = new Map<string, number>();

export function newSlotId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize legacy single-config into slots array. */
export function normalizeSlots(cfg: LegacyCreds | undefined | null): CredSlotLike[] {
  if (!cfg) return [];
  if (Array.isArray(cfg.slots) && cfg.slots.length > 0) {
    return cfg.slots
      .filter((s) => s && typeof s === "object" && typeof s.id === "string" && s.id)
      .map((s) => ({
        id: s.id,
        label: typeof s.label === "string" ? s.label : undefined,
        usePlatform: Boolean(s.usePlatform),
        apiKey: typeof s.apiKey === "string" ? s.apiKey : undefined,
        baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : undefined,
        extra:
          s.extra && typeof s.extra === "object"
            ? Object.fromEntries(
                Object.entries(s.extra).filter(
                  ([, v]) => typeof v === "string",
                ) as [string, string][],
              )
            : undefined,
      }));
  }
  const hasLegacy =
    Boolean(cfg.apiKey?.trim()) ||
    Boolean(cfg.baseUrl?.trim()) ||
    Boolean(cfg.extra && Object.keys(cfg.extra).length) ||
    cfg.enabled === true;
  if (!hasLegacy) return [];
  return [
    {
      id: "legacy",
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      extra: cfg.extra,
    },
  ];
}

/** Round-robin pick among slots. Key should include tenant for isolation. */
export function pickSlotRoundRobin(
  scopeKey: string,
  slots: CredSlotLike[],
): CredSlotLike | null {
  if (!slots.length) return null;
  if (slots.length === 1) return slots[0]!;
  const i = rrCounters.get(scopeKey) ?? 0;
  const slot = slots[i % slots.length]!;
  rrCounters.set(scopeKey, i + 1);
  return slot;
}

export function redactSlot(slot: CredSlotLike, secretExtraKeys: string[] = []): {
  id: string;
  label?: string;
  usePlatform?: boolean;
  hasApiKey: boolean;
  baseUrl?: string;
  extra?: Record<string, string>;
} {
  const extra: Record<string, string> | undefined = slot.extra
    ? Object.fromEntries(
        Object.entries(slot.extra).map(([k, v]) =>
          secretExtraKeys.includes(k) ? [k, v ? "••••••••" : ""] : [k, v],
        ),
      )
    : undefined;
  return {
    id: slot.id,
    label: slot.label,
    usePlatform: slot.usePlatform || undefined,
    hasApiKey: Boolean(slot.apiKey?.trim()),
    baseUrl: slot.baseUrl,
    extra,
  };
}

const SECRET_MASK = "••••••••";

function isMasked(v: string | undefined): boolean {
  if (!v) return true;
  return v === SECRET_MASK || /^•+$/.test(v);
}

/**
 * Merge client-submitted slots with previous secrets.
 * Empty / masked apiKey keeps the previous value (tenant-isolated previous config).
 */
export function mergeSlots(
  incoming: CredSlotLike[] | undefined,
  previous: CredSlotLike[] | undefined,
  secretExtraKeys: string[] = [],
): CredSlotLike[] {
  const prevById = new Map((previous ?? []).map((s) => [s.id, s]));
  const list = Array.isArray(incoming) ? incoming : [];
  return list
    .filter((s) => s && typeof s.id === "string" && s.id.trim())
    .map((s) => {
      const prev = prevById.get(s.id);
      const apiKey =
        typeof s.apiKey === "string" && s.apiKey.trim() && !isMasked(s.apiKey)
          ? s.apiKey.trim()
          : prev?.apiKey;
      const extra: Record<string, string> = { ...(prev?.extra ?? {}) };
      if (s.extra && typeof s.extra === "object") {
        for (const [k, v] of Object.entries(s.extra)) {
          if (typeof v !== "string") continue;
          if (secretExtraKeys.includes(k) && isMasked(v)) continue;
          if (v === "" && secretExtraKeys.includes(k)) {
            delete extra[k];
            continue;
          }
          extra[k] = v;
        }
      }
      return {
        id: s.id.trim(),
        label: typeof s.label === "string" ? s.label.trim() || undefined : undefined,
        usePlatform: Boolean(s.usePlatform),
        apiKey: apiKey || undefined,
        baseUrl:
          typeof s.baseUrl === "string" ? s.baseUrl.trim() || undefined : prev?.baseUrl,
        extra: Object.keys(extra).length ? extra : undefined,
      } satisfies CredSlotLike;
    });
}

export function redactEngineMap(
  engines: Record<string, LegacyCreds | undefined> | undefined,
  secretExtraKeysFor?: (id: string) => string[],
): Record<
  string,
  {
    enabled: boolean;
    slots: ReturnType<typeof redactSlot>[];
  }
> {
  const out: Record<
    string,
    { enabled: boolean; slots: ReturnType<typeof redactSlot>[] }
  > = {};
  for (const [id, cfg] of Object.entries(engines ?? {})) {
    if (!cfg) continue;
    const slots = normalizeSlots(cfg);
    out[id] = {
      enabled: Boolean(cfg.enabled),
      slots: slots.map((s) => redactSlot(s, secretExtraKeysFor?.(id) ?? [])),
    };
  }
  return out;
}
