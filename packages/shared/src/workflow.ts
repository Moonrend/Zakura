/** Side-effect-free workflow planning protocol, version 1. Costs use integer
 * micro-units of one consistent currency selected by the caller. */
export type WorkflowNode = {
  id: string;
  name?: string;
  kind?: "agent" | "tool" | "checkpoint";
  dependsOn?: string[];
  durationMs: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  costMicros?: number;
  resources?: Record<string, number>;
  concurrencyKey?: string;
};

export type WorkflowDefinition = {
  version: 1;
  name: string;
  nodes: WorkflowNode[];
};

export type WorkflowOptions = {
  maxParallel?: number;
  resources?: Record<string, number>;
  concurrencyLimits?: Record<string, number>;
  mode?: "nominal" | "retryBound";
  priority?: "criticalPath" | "id";
  budgetMicros?: number;
  deadlineMs?: number;
};

export type WorkflowRequest = {
  definition: WorkflowDefinition;
  options: WorkflowOptions;
};

export type WorkflowDiagnostic = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  nodeIds?: string[];
};

export type WorkflowValidation = {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
  topologicalOrder: string[];
  layers: string[][];
};

export type WorkflowNodeAnalysis = {
  id: string;
  durationMs: number;
  retryBoundMs: number;
  costMicros: number;
  earliestStartMs: number;
  earliestFinishMs: number;
  latestStartMs: number;
  slackMs: number;
  tailMs: number;
  level: number;
  critical: boolean;
};

export type WorkflowSlot = {
  nodeId: string;
  startMs: number;
  endMs: number;
  waitMs: number;
  resources: Record<string, number>;
  concurrencyKey?: string;
};

export type WorkflowResult = {
  version: 1;
  fingerprint: string;
  options: WorkflowOptions;
  validation: WorkflowValidation;
  analysis?: {
    nodes: WorkflowNodeAnalysis[];
    roots: string[];
    sinks: string[];
    criticalPath: string[];
    criticalPathMs: number;
    totalWorkMs: number;
    totalCostMicros: number;
    parallelLowerBoundMs: number;
    resourceLowerBoundsMs: Record<string, number>;
  };
  schedule?: {
    slots: WorkflowSlot[];
    usage: Array<{
      atMs: number;
      running: number;
      resources: Record<string, number>;
    }>;
    makespanMs: number;
    peakParallel: number;
    peakResources: Record<string, number>;
    utilization: number;
    withinBudget: boolean;
    withinDeadline: boolean;
    optimal: boolean;
  };
};

export type WorkflowTemplate = {
  id: string;
  description: string;
  request: WorkflowRequest;
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new Error(`${path}.${key} is not supported`);
  }
}

function text(value: unknown, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}

function integer(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer`);
  }
}

function capacities(value: unknown, path: string) {
  const map = object(value, path);
  if (Object.keys(map).length > 32)
    throw new Error(`${path} supports at most 32 keys`);
  for (const [key, units] of Object.entries(map))
    integer(units, `${path}.${key}`);
}

/** Check import shape before rendering editors. Graph, capacity and range
 * validation remains authoritative on the server. Unknown fields are rejected
 * to match the Go API's strict JSON decoder. */
export function parseWorkflowRequest(raw: string): WorkflowRequest {
  // Keep this package portable: its tsconfig intentionally has no DOM or
  // Node globals. Count Unicode scalar UTF-8 widths without TextEncoder.
  let bytes = 0;
  for (const character of raw) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 2 * 1024 * 1024) break;
  }
  if (bytes > 2 * 1024 * 1024) {
    throw new Error("Workflow JSON exceeds 2 MiB");
  }
  const req = object(JSON.parse(raw), "workflow");
  fields(req, ["definition", "options"], "workflow");
  const def = object(req.definition, "definition");
  fields(def, ["version", "name", "nodes"], "definition");
  if (def.version !== 1)
    throw new Error("Only workflow version 1 is supported");
  text(def.name, "definition.name");
  if (
    !Array.isArray(def.nodes) ||
    def.nodes.length < 1 ||
    def.nodes.length > 128
  ) {
    throw new Error("Supply between 1 and 128 nodes");
  }
  for (const [index, rawNode] of def.nodes.entries()) {
    const path = `definition.nodes[${index}]`;
    const node = object(rawNode, path);
    fields(
      node,
      [
        "id",
        "name",
        "kind",
        "dependsOn",
        "durationMs",
        "timeoutMs",
        "maxAttempts",
        "backoffMs",
        "backoffMultiplier",
        "maxBackoffMs",
        "costMicros",
        "resources",
        "concurrencyKey",
      ],
      path,
    );
    text(node.id, `${path}.id`);
    integer(node.durationMs, `${path}.durationMs`);
    for (const key of ["name", "concurrencyKey"]) {
      if (node[key] !== undefined) text(node[key], `${path}.${key}`);
    }
    if (
      node.kind !== undefined &&
      !["agent", "tool", "checkpoint"].includes(node.kind as string)
    ) {
      throw new Error(`${path}.kind is not supported`);
    }
    for (const key of [
      "timeoutMs",
      "maxAttempts",
      "backoffMs",
      "backoffMultiplier",
      "maxBackoffMs",
      "costMicros",
    ]) {
      if (node[key] !== undefined) integer(node[key], `${path}.${key}`);
    }
    if (node.dependsOn !== undefined) {
      if (!Array.isArray(node.dependsOn) || node.dependsOn.length > 128)
        throw new Error(
          `${path}.dependsOn must be an array of at most 128 ids`,
        );
      node.dependsOn.forEach((id, i) => text(id, `${path}.dependsOn[${i}]`));
    }
    if (node.resources !== undefined)
      capacities(node.resources, `${path}.resources`);
  }
  const opts = object(req.options, "options");
  fields(
    opts,
    [
      "maxParallel",
      "resources",
      "concurrencyLimits",
      "mode",
      "priority",
      "budgetMicros",
      "deadlineMs",
    ],
    "options",
  );
  for (const key of ["maxParallel", "budgetMicros", "deadlineMs"]) {
    if (opts[key] !== undefined) integer(opts[key], `options.${key}`);
  }
  if (
    opts.mode !== undefined &&
    !["nominal", "retryBound"].includes(opts.mode as string)
  )
    throw new Error("options.mode is not supported");
  if (
    opts.priority !== undefined &&
    !["criticalPath", "id"].includes(opts.priority as string)
  )
    throw new Error("options.priority is not supported");
  for (const key of ["resources", "concurrencyLimits"]) {
    if (opts[key] !== undefined) capacities(opts[key], `options.${key}`);
  }
  return req as WorkflowRequest;
}

export function workflowDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(2)} min`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

/** Compute bounded percentages for a timeline. Zero/invalid makespan and
 * malformed slots produce no geometry instead of NaN CSS values. */
export function workflowTimeline(
  slot: WorkflowSlot,
  makespanMs: number,
): { left: number; width: number } | null {
  if (
    !Number.isFinite(makespanMs) ||
    makespanMs <= 0 ||
    !Number.isFinite(slot.startMs) ||
    !Number.isFinite(slot.endMs) ||
    slot.startMs < 0 ||
    slot.endMs <= slot.startMs ||
    slot.endMs > makespanMs
  )
    return null;
  return {
    left: (slot.startMs / makespanMs) * 100,
    width: ((slot.endMs - slot.startMs) / makespanMs) * 100,
  };
}
