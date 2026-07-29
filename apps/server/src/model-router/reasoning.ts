import type {
  ModelCatalogEntry,
  ModelRouteOptions,
  ModelUpstreamProtocol,
} from "@zakura/shared";

type Body = Record<string, unknown>;

const EFFORT_TO_BUDGET: Record<string, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

function reasoningEnabled(options: ModelRouteOptions): boolean {
  const r = options.reasoning;
  return Boolean(r && (r.enabled === false || r.effort || r.budgetTokens));
}

function rawReasoningOptions(meta?: ModelCatalogEntry): Array<Record<string, unknown>> {
  const raw = meta?.raw?.reasoning_options;
  return Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function hasRawReasoningOption(meta: ModelCatalogEntry | undefined, type: string): boolean {
  return rawReasoningOptions(meta).some((item) => item.type === type);
}

function applyMetadataReasoningOptions(
  body: Body,
  options: ModelRouteOptions,
  meta?: ModelCatalogEntry,
): boolean {
  const r = options.reasoning;
  if (!r) return false;
  const hasToggle = hasRawReasoningOption(meta, "toggle");
  const hasEffort = hasRawReasoningOption(meta, "effort");
  if (!hasToggle && !hasEffort) return false;

  if (r.enabled === false) {
    if (hasToggle) body.enable_thinking = false;
    return true;
  }
  if (hasToggle) body.enable_thinking = true;
  if (hasEffort && r.effort) body.reasoning_effort = r.effort;
  return true;
}

export function applyReasoningOptions(
  protocol: ModelUpstreamProtocol,
  body: Body,
  options: ModelRouteOptions,
  meta?: ModelCatalogEntry,
): void {
  const r = options.reasoning;
  if (!r || !reasoningEnabled(options)) return;
  const effort = r.enabled === false ? "none" : r.effort;
  const budgetTokens =
    r.budgetTokens ??
    (effort && effort !== "none" ? EFFORT_TO_BUDGET[effort] : undefined);

  if (protocol === "anthropic") {
    if (effort === "none") return;
    if (budgetTokens) {
      body.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }
    return;
  }

  if (protocol === "gemini") {
    if (effort === "none") {
      body.generationConfig = {
        ...((body.generationConfig && typeof body.generationConfig === "object"
          ? body.generationConfig
          : {}) as Body),
        thinkingConfig: { thinkingBudget: 0 },
      };
      return;
    }
    const generationConfig =
      body.generationConfig && typeof body.generationConfig === "object"
        ? (body.generationConfig as Body)
        : {};
    generationConfig.thinkingConfig = {
      ...(budgetTokens ? { thinkingBudget: budgetTokens } : {}),
      ...(r.includeThoughts ? { includeThoughts: true } : {}),
    };
    body.generationConfig = generationConfig;
    return;
  }

  if (protocol === "openai" || protocol === "azure-openai") {
    if (effort === "none") return;
    if (effort) body.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
    if (r.summary) body.reasoning_summary = r.summary;
    return;
  }

  if (applyMetadataReasoningOptions(body, options, meta)) {
    if (r.summary) body.reasoning_summary = r.summary;
    return;
  }

  if (effort === "none") return;
  body.reasoning = {
    ...(effort ? { effort } : {}),
    ...(budgetTokens ? { max_tokens: budgetTokens, enabled: true } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
  };
}
