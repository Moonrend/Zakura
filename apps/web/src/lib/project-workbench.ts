"use client";

import { api } from "@/lib/api";
import type {
  Analysis,
  CheckSpec,
  Project,
  ProjectConfig,
  Run,
} from "./project-execution";

const seg = encodeURIComponent;
const project = (id: string) => `/api/project-executions/${seg(id)}`;
const query = (
  values: Record<string, string | number | boolean | undefined>,
) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};
export type Scalar = string | number | boolean;
export type BlueprintParameter = {
  name: string;
  title: string;
  description?: string;
  type: "string" | "int" | "bool" | "enum" | "path";
  required: boolean;
  default?: Scalar;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};
export type BlueprintCondition =
  | { ref: string; op: "eq" | "ne"; value: Scalar }
  | { ref: string; op: "in"; values: Scalar[] }
  | { ref: string; op: "present" }
  | { all: BlueprintCondition[] }
  | { any: BlueprintCondition[] }
  | { not: BlueprintCondition };
export type BlueprintTask = {
  key: string;
  title: string;
  prompt: string;
  agentRole: string;
  model?: string;
  dependsOn: { task: string; matchAxes?: string[] }[];
  writes: string[];
  priority: number;
  maxAttempts: number;
  checks: CheckSpec[];
  matrix?: Record<string, string[]>;
  when?: BlueprintCondition;
};
export type BlueprintDefinition = {
  name: string;
  description: string;
  projectName: string;
  goal: string;
  parameters: BlueprintParameter[];
  tasks: BlueprintTask[];
  config: ProjectConfig;
};
export type BlueprintDocument = {
  schema: "zakura.project-blueprint";
  version: 1;
  blueprint: BlueprintDefinition;
};
export type ProjectTemplate = {
  id: string;
  tenantId: string;
  revision: number;
  currentVersion: number;
  definition: BlueprintDefinition;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type TemplateVersion = {
  templateId: string;
  version: number;
  definition: BlueprintDefinition;
  createdBy: string;
  createdAt: string;
};
export type BlueprintInputs = {
  parameters: Record<string, Scalar>;
  agentMapping: Record<string, string>;
  spaceId: string;
  name?: string;
};
export type Expansion = {
  project: Project;
  analysis: Analysis;
  instances: { taskId: string; key: string; axes: Record<string, string> }[];
  skipped: { taskId: string; key: string; axes: Record<string, string> }[];
  roles: string[];
  templateId?: string;
  templateVersion?: number;
};
const templates = "/api/project-templates";
export const listTemplates = () =>
  api<{ items: ProjectTemplate[] }>(`${templates}/`, { cacheTtlMs: false });
export const getRecipes = () =>
  api<{ items: { id: string; definition: BlueprintDefinition }[] }>(
    `${templates}/recipes`,
  );
export const getTemplate = (id: string) =>
  api<ProjectTemplate>(`${templates}/${seg(id)}/`, { cacheTtlMs: false });
export const saveTemplate = (
  definition: BlueprintDefinition,
  current?: ProjectTemplate,
) =>
  api<ProjectTemplate>(
    current ? `${templates}/${seg(current.id)}/` : `${templates}/`,
    {
      method: current ? "PATCH" : "POST",
      json: {
        definition,
        ...(current ? { expectedRevision: current.revision } : {}),
      },
    },
  );
export const deleteTemplate = (current: ProjectTemplate) =>
  api(`${templates}/${seg(current.id)}/?expectedRevision=${current.revision}`, {
    method: "DELETE",
  });
export const templateVersions = (id: string) =>
  api<{ items: TemplateVersion[] }>(`${templates}/${seg(id)}/versions`, {
    cacheTtlMs: false,
  });
export const exportTemplate = (id: string, version: number) =>
  api<BlueprintDocument>(`${templates}/${seg(id)}/export?version=${version}`, {
    cacheTtlMs: false,
  });
export const importTemplate = (document: BlueprintDocument) =>
  api<ProjectTemplate>(`${templates}/import`, {
    method: "POST",
    json: document,
  });
export const previewBlueprint = (
  definition: BlueprintDefinition,
  inputs: BlueprintInputs,
) =>
  api<Expansion>(`${templates}/preview`, {
    method: "POST",
    json: { definition, ...inputs },
  });
export const instantiateTemplate = (
  current: ProjectTemplate,
  version: number,
  inputs: BlueprintInputs,
) =>
  api<Expansion>(`${templates}/${seg(current.id)}/instantiate`, {
    method: "POST",
    json: { expectedRevision: current.revision, version, ...inputs },
  });

export type KnowledgeSource = {
  kind: "snapshot" | "knowledge" | "url";
  label?: string;
  snapshotId?: string;
  path?: string;
  entryId?: string;
  revision?: number;
  url?: string;
};
export type KnowledgeDraft = {
  kind: "note" | "decision" | "question";
  title: string;
  body: string;
  format: "markdown" | "text";
  tags: string[];
  sources: KnowledgeSource[];
  runId?: string;
  taskId?: string;
};
export type KnowledgeEntry = KnowledgeDraft & {
  id: string;
  projectId: string;
  status: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};
export type KnowledgeRevision = {
  entry: KnowledgeEntry;
  action: string;
  comment?: string;
  authorId: string;
  createdAt: string;
};
export type KnowledgeComment = {
  id: string;
  entryId: string;
  revision: number;
  body: string;
  authorId: string;
  createdAt: string;
};
export type Highlight = { start: number; end: number };
export type KnowledgeHit = {
  entry: KnowledgeEntry;
  score: number;
  titleHighlights: Highlight[];
  snippet: { text: string; start: number; highlights: Highlight[] };
  matchedTerms: string[];
};
export type KnowledgeSearch = {
  items: KnowledgeHit[];
  terms: string[];
  candidates: number;
  corpusSize: number;
  truncated: boolean;
  algorithm: string;
};
export type KnowledgeFilter = {
  kind?: string;
  status?: string;
  tag?: string;
  runId?: string;
  taskId?: string;
  includeArchived?: boolean;
};
const knowledge = (pid: string) => `${project(pid)}/knowledge`;
export const listKnowledge = (
  pid: string,
  filter: KnowledgeFilter,
  cursor?: string,
) =>
  api<{ items: KnowledgeEntry[]; nextCursor?: string }>(
    `${knowledge(pid)}?${query({ ...filter, cursor, limit: 50 })}`,
    { cacheTtlMs: false },
  );
export const searchKnowledge = (
  pid: string,
  q: string,
  filter: KnowledgeFilter,
) =>
  api<KnowledgeSearch>(
    `${knowledge(pid)}/search?${query({ ...filter, q, limit: 30 })}`,
    { cacheTtlMs: false },
  );
export const getKnowledge = (pid: string, id: string, revision?: number) =>
  api<KnowledgeEntry>(`${knowledge(pid)}/${seg(id)}?${query({ revision })}`, {
    cacheTtlMs: false,
  });
export const saveKnowledge = (
  pid: string,
  draft: KnowledgeDraft,
  current?: KnowledgeEntry,
  comment = "",
) =>
  api<KnowledgeEntry>(
    current ? `${knowledge(pid)}/${seg(current.id)}` : knowledge(pid),
    {
      method: current ? "PATCH" : "POST",
      json: {
        ...draft,
        ...(current ? { expectedRevision: current.revision, comment } : {}),
      },
    },
  );
export const changeKnowledgeState = (
  pid: string,
  current: KnowledgeEntry,
  action: string,
  comment: string,
) =>
  api<KnowledgeEntry>(`${knowledge(pid)}/${seg(current.id)}/state`, {
    method: "POST",
    json: { expectedRevision: current.revision, action, comment },
  });
export const deleteKnowledge = (
  pid: string,
  current: KnowledgeEntry,
  comment: string,
) =>
  api<KnowledgeEntry>(`${knowledge(pid)}/${seg(current.id)}`, {
    method: "DELETE",
    json: { expectedRevision: current.revision, comment },
  });
export const knowledgeHistory = (pid: string, id: string, before?: number) =>
  api<{ items: KnowledgeRevision[] }>(
    `${knowledge(pid)}/${seg(id)}/history?${query({ before, limit: 30 })}`,
    { cacheTtlMs: false },
  );
export const knowledgeComments = (pid: string, id: string, cursor?: string) =>
  api<{ items: KnowledgeComment[]; cursor?: string }>(
    `${knowledge(pid)}/${seg(id)}/comments?${query({ cursor, limit: 50 })}`,
    { cacheTtlMs: false },
  );
export const addKnowledgeComment = (
  pid: string,
  current: KnowledgeEntry,
  body: string,
) =>
  api<KnowledgeComment>(`${knowledge(pid)}/${seg(current.id)}/comments`, {
    method: "POST",
    json: { expectedRevision: current.revision, body },
  });

export type PortfolioPolicy = {
  revision: number;
  enabled: boolean;
  maxActiveTasks: number;
  defaultAgentModelCalls: number;
  defaultAgentToolCalls: number;
  agents: { agentId: string; maxModelCalls: number; maxToolCalls: number }[];
  agingSeconds: number;
};
export type PortfolioCounts = {
  pending: number;
  active: number;
  waitingReview: number;
  waitingApproval: number;
  unknown: number;
  completed: number;
  failed: number;
  cancelled: number;
};
export type PortfolioProject = {
  project: Project;
  scheduling: { priority: number; weight: number };
  fairService: number;
  runs: {
    run: Run;
    counts: PortfolioCounts;
    blocking: { code: string; detail: string; nextEligibleAt?: string }[];
  }[];
};
export type Portfolio = {
  policy: PortfolioPolicy;
  totals: {
    projects: number;
    runs: number;
    pendingTasks: number;
    activeTasks: number;
    waitingReviewTasks: number;
    unknownOperations: number;
    tokens: number;
    modelCalls: number;
    toolCalls: number;
  };
  projects: PortfolioProject[];
  truncated: boolean;
  generatedAt: string;
  concurrencyScope: string;
};
export type PortfolioActionItem = {
  projectId: string;
  runId: string;
  expectedRevision: number;
};
export type PortfolioActionResult = {
  projectId: string;
  runId: string;
  status: string;
  run?: Run;
  error?: string;
};
export const getPortfolio = (spaceId = "") =>
  api<Portfolio>(`/api/project-portfolio/?${query({ spaceId, limit: 200 })}`, {
    cacheTtlMs: false,
  });
export const savePortfolioPolicy = (policy: PortfolioPolicy) =>
  api<PortfolioPolicy>("/api/project-portfolio/policy", {
    method: "PUT",
    json: { ...policy, expectedRevision: policy.revision },
  });
export const portfolioAction = (
  action: "pause" | "resume" | "cancel",
  items: PortfolioActionItem[],
) =>
  api<{ items: PortfolioActionResult[] }>(
    "/api/project-portfolio/runs/actions",
    { method: "POST", json: { action, items } },
  );
export const setProjectScheduling = (
  item: PortfolioProject,
  priority: number,
  weight: number,
) =>
  api<Project>(
    `/api/project-portfolio/projects/${seg(item.project.id)}/scheduling`,
    {
      method: "PATCH",
      json: { expectedRevision: item.project.revision, priority, weight },
    },
  );

export type SourcePosition = { offset: number; line: number; column: number };
export type SourceRange = { start: SourcePosition; end: SourcePosition };
export type SemanticDiagnostic = {
  path: string;
  code: string;
  message: string;
  severity: string;
  range?: SourceRange;
};
export type SemanticSymbol = {
  id: string;
  key: string;
  name: string;
  kind: string;
  path: string;
  package?: string;
  receiver?: string;
  exported: boolean;
  signature: string;
  range: SourceRange;
  selection: SourceRange;
  confidence: string;
};
export type SemanticReference = {
  path: string;
  name: string;
  kind: string;
  qualifier?: string;
  range: SourceRange;
  symbolIds: string[];
  confidence: string;
};
export type SemanticEdge = {
  from: string;
  to: string;
  kind: string;
  confidence: string;
};
export type SemanticFileSummary = {
  path: string;
  language: string;
  package?: string;
  generated: boolean;
  test: boolean;
  status: string;
  symbols: number;
  references: number;
};
export type SemanticSummary = {
  snapshotId: string;
  version: string;
  complete: boolean;
  indexedFiles: number;
  skippedFiles: number;
  symbols: number;
  references: number;
  files: SemanticFileSummary[];
  diagnostics: SemanticDiagnostic[];
  edges: SemanticEdge[];
  cycles: { files: string[] }[];
  limitations: string[];
};
export type SemanticSearch = {
  snapshotId: string;
  version: string;
  symbols: SemanticSymbol[];
  total: number;
  truncated: boolean;
};
export type SemanticNavigation = {
  snapshotId: string;
  symbol: SemanticSymbol;
  references: SemanticReference[];
  total: number;
  truncated: boolean;
};
export type SemanticFile = {
  snapshotId: string;
  version: string;
  file: Omit<SemanticFileSummary, "symbols" | "references"> & {
    hash: string;
    buildConditions: string[];
    symbols: SemanticSymbol[];
    references: SemanticReference[];
    imports: {
      path: string;
      name?: string;
      range: SourceRange;
      targets: string[];
      confidence: string;
    }[];
    diagnostics: SemanticDiagnostic[];
  };
  dependencies: SemanticEdge[];
  dependents: SemanticEdge[];
  truncated: boolean;
  totalSymbols: number;
  totalReferences: number;
  totalImports: number;
};
export type SemanticComparison = {
  beforeSnapshot: string;
  afterSnapshot: string;
  version: string;
  complete: boolean;
  truncated: boolean;
  counts: {
    changes: number;
    apiChanges: number;
    impacted: number;
    relatedTests: number;
  };
  changes: {
    path: string;
    oldPath?: string;
    kind: string;
    confidence: string;
  }[];
  apiChanges: {
    key: string;
    kind: string;
    classification: string;
    reason: string;
    confidence: string;
    before: SemanticSymbol[];
    after: SemanticSymbol[];
  }[];
  impacted: {
    path: string;
    reason: string;
    via: string[];
    confidence: string;
  }[];
  relatedTests: {
    path: string;
    sourcePath: string;
    reason: string;
    confidence: string;
  }[];
  diagnostics: SemanticDiagnostic[];
  limitations: string[];
};
const semantic = (pid: string, sid: string) =>
  `${project(pid)}/snapshots/${seg(sid)}/semantic`;
export const semanticSummary = (pid: string, sid: string) =>
  api<SemanticSummary>(semantic(pid, sid), { cacheTtlMs: false });
export const semanticSearch = (
  pid: string,
  sid: string,
  input: {
    q: string;
    path?: string;
    kind?: string;
    exportedOnly?: boolean;
    offset?: number;
  },
) =>
  api<SemanticSearch>(
    `${semantic(pid, sid)}/search?${query({ ...input, limit: 100 })}`,
    { cacheTtlMs: false },
  );
export const semanticFile = (pid: string, sid: string, path: string) =>
  api<SemanticFile>(`${semantic(pid, sid)}/file?${query({ path })}`, {
    cacheTtlMs: false,
  });
export const semanticSymbol = (pid: string, sid: string, id: string) =>
  api<SemanticNavigation>(`${semantic(pid, sid)}/symbol/${seg(id)}`, {
    cacheTtlMs: false,
  });
export const compareSemantic = (pid: string, before: string, after: string) =>
  api<SemanticComparison>(
    `${semantic(pid, after)}/compare?${query({ before })}`,
    { cacheTtlMs: false },
  );

/** Highlight indices are Unicode code points, not UTF-16 offsets. Invalid overlapping ranges are ignored. */
export function highlightedParts(text: string, highlights: Highlight[]) {
  const points = Array.from(text);
  const parts: { text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const range of [...highlights].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < cursor ||
      range.end <= range.start ||
      range.end > points.length
    )
      continue;
    if (range.start > cursor)
      parts.push({
        text: points.slice(cursor, range.start).join(""),
        matched: false,
      });
    parts.push({
      text: points.slice(range.start, range.end).join(""),
      matched: true,
    });
    cursor = range.end;
  }
  if (cursor < points.length)
    parts.push({ text: points.slice(cursor).join(""), matched: false });
  return parts;
}

export function parseBlueprintDocument(text: string): BlueprintDocument {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object")
    throw new Error("导入内容必须是蓝图 JSON 对象");
  const document = value as Partial<BlueprintDocument>;
  if (
    document.schema !== "zakura.project-blueprint" ||
    document.version !== 1 ||
    !document.blueprint ||
    !Array.isArray(document.blueprint.tasks) ||
    !Array.isArray(document.blueprint.parameters)
  )
    throw new Error("导入格式或版本不受支持，需 zakura.project-blueprint v1");
  return document as BlueprintDocument;
}
