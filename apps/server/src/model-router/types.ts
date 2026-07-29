import type {
  ModelCapability,
  ModelCatalogEntry,
  ModelRouteOptions,
  ModelUpstreamConfig,
  ModelUpstreamProtocol,
} from "@zakura/shared";
import { applyUpstreamProtocolDefaults } from "@zakura/shared";

export type ResolvedRoute = {
  routeId: string;
  routeSlug: string;
  /** 逻辑模型别名：同 alias 多供应商时按 weight 随机 */
  alias: string;
  capability: ModelCapability;
  model: string;
  weight: number;
  options: ModelRouteOptions;
  meta?: ModelCatalogEntry;
  upstream: {
    id: string;
    protocol: ModelUpstreamProtocol;
    config: ModelUpstreamConfig;
  };
};

export function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 解析上游配置；传入 protocol 时会套用该类型的预设地址 */
export function parseUpstreamConfig(
  raw: Record<string, unknown>,
  protocol: ModelUpstreamProtocol = "custom",
): ModelUpstreamConfig {
  return applyUpstreamProtocolDefaults(protocol, raw);
}

export function parseRouteOptions(raw: Record<string, unknown>): ModelRouteOptions {
  const opts: ModelRouteOptions = {};
  if (typeof raw.dimensions === "number" && raw.dimensions > 0) {
    opts.dimensions = Math.floor(raw.dimensions);
  }
  if (typeof raw.topN === "number" && raw.topN > 0) {
    opts.topN = Math.floor(raw.topN);
  }
  if (typeof raw.temperature === "number") opts.temperature = raw.temperature;
  if (typeof raw.maxTokens === "number" && raw.maxTokens > 0) {
    opts.maxTokens = Math.floor(raw.maxTokens);
  }
  if (typeof raw.instruct === "string") opts.instruct = raw.instruct;
  if (typeof raw.size === "string") opts.size = raw.size;
  if (typeof raw.quality === "string") opts.quality = raw.quality;
  if (raw.responseFormat === "url" || raw.responseFormat === "b64_json") {
    opts.responseFormat = raw.responseFormat;
  }
  if (raw.reasoning && typeof raw.reasoning === "object") {
    const r = raw.reasoning as Record<string, unknown>;
    const reasoning: NonNullable<ModelRouteOptions["reasoning"]> = {};
    if (typeof r.enabled === "boolean") reasoning.enabled = r.enabled;
    if (typeof r.effort === "string" && r.effort.trim()) {
      reasoning.effort = r.effort.trim();
    }
    if (r.summary === "auto" || r.summary === "concise" || r.summary === "detailed") {
      reasoning.summary = r.summary;
    }
    if (typeof r.budgetTokens === "number" && r.budgetTokens > 0) {
      reasoning.budgetTokens = Math.floor(r.budgetTokens);
    }
    if (typeof r.includeThoughts === "boolean") {
      reasoning.includeThoughts = r.includeThoughts;
    }
    if (Object.keys(reasoning).length > 0) opts.reasoning = reasoning;
  }
  if (raw.extensions && typeof raw.extensions === "object") {
    opts.extensions = raw.extensions as Record<string, unknown>;
  }
  return opts;
}

export function rowToResolvedRoute(input: {
  routeId: string;
  routeSlug: string;
  alias?: string | null;
  capability: string;
  model: string;
  weight?: string | number | null;
  optionsJson: string;
  metaJson?: string;
  upstreamId: string;
  protocol: string;
  configJson: string;
}): ResolvedRoute {
  const weightNum =
    typeof input.weight === "number"
      ? input.weight
      : Number(input.weight ?? 100);
  const protocol = input.protocol as ModelUpstreamProtocol;
  const meta = input.metaJson
    ? (parseJsonRecord(input.metaJson) as unknown as ModelCatalogEntry)
    : undefined;

  return {
    routeId: input.routeId,
    routeSlug: input.routeSlug,
    alias: (input.alias?.trim() || input.model).trim(),
    capability: input.capability as ModelCapability,
    model: input.model,
    weight: Number.isFinite(weightNum) && weightNum > 0 ? weightNum : 100,
    options: parseRouteOptions(parseJsonRecord(input.optionsJson)),
    meta,
    upstream: {
      id: input.upstreamId,
      protocol,
      config: parseUpstreamConfig(parseJsonRecord(input.configJson), protocol),
    },
  };
}
