"use client";

import { api, ApiError, getSession } from "./api";
const seg = encodeURIComponent;
const base = (pid: string) => `/api/project-executions/${seg(pid)}`;
const run = (pid: string, rid: string) => `${base(pid)}/runs/${seg(rid)}`;
export type InsightNotice = { code: string; taskId?: string; message: string };
export type InsightUsage = {
  tokens: number;
  modelCalls: number;
  toolCalls: number;
};
export type InsightBlocker = {
  code: string;
  taskId?: string;
  operationId?: string;
  message: string;
  evidence: string;
  chain?: string[];
};
export type InsightInterval = {
  start: string;
  end?: string;
  seconds?: number;
  startSequence: number;
  endSequence?: number;
  outcome: string;
  recoveries: number;
};
export type InsightTask = {
  taskId: string;
  specId: string;
  title: string;
  status: string;
  attempt: number;
  reused: boolean;
  intervals: InsightInterval[];
  observedSeconds?: number;
  durationComplete: boolean;
  firstStartedAt?: string;
  finishedAt?: string;
  reviewSeconds?: number;
  retryRequests: number;
  recoveries: number;
  checkpoints: {
    id: string;
    sequence: number;
    nextTool: number;
    eventSequence: number;
    createdAt: string;
  }[];
  usage: InsightUsage;
  operationStatuses: Record<string, number>;
  verificationStatuses: Record<string, number>;
  tokensPerObservedSecond?: number;
  blockers: InsightBlocker[];
  warnings: InsightNotice[];
};
export type InsightCriticalPath = {
  taskIds: string[];
  seconds?: number;
  knownLowerBoundSeconds: number;
  unknownTaskIds: string[];
};
export type RunInsight = {
  runId: string;
  projectId: string;
  planVersion: number;
  status: string;
  createdAt: string;
  usage: InsightUsage;
  attributedUsage: InsightUsage;
  unattributedUsage: InsightUsage;
  elapsedSeconds?: number;
  finishedAt?: string;
  tasks: InsightTask[];
  criticalPath: InsightCriticalPath;
  statusCounts: Record<string, number>;
  warnings: InsightNotice[];
  eventCount: number;
  evidenceComplete: boolean;
};
export type DurationEstimate = {
  specId: string;
  source: "unknown" | "observed";
  samples: number;
  p50Seconds?: number;
  p90Seconds?: number;
  medianInterval?: {
    low: number;
    high: number;
    confidence: number;
    replicates: number;
  };
  runIds: string[];
  warnings: string[];
};
export type ProjectInsight = {
  projectId: string;
  runs: RunInsight[];
  estimates: DurationEstimate[];
  warnings: InsightNotice[];
};
export type InsightComparison = {
  left: RunInsight;
  right: RunInsight;
  warnings: InsightNotice[];
  tasks: {
    specId: string;
    change: string;
    comparable: boolean;
    reason?: string;
    left?: InsightTask;
    right?: InsightTask;
    durationDeltaSeconds?: number;
    tokenDelta?: number;
  }[];
};
export type InsightScenario = {
  id: string;
  label: string;
  maxConcurrent: number;
  durations: Record<string, number>;
  capacities: Record<string, number>;
  resources: Record<string, Record<string, number>>;
  costs: Record<string, InsightUsage>;
  serializeWrites?: boolean;
};
export type ScenarioResult = {
  id: string;
  label: string;
  status: "complete" | "unknown" | "blocked";
  maxConcurrent: number;
  makespanSeconds?: number;
  utilization?: number;
  resourceUtilization: Record<string, number>;
  timeline: {
    specId: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    durationSource: "override" | "observed";
    resources: Record<string, number>;
  }[];
  criticalPath: InsightCriticalPath;
  unknownTaskIds: string[];
  blockers: InsightBlocker[];
  budget: {
    status: "within" | "unknown" | "exceeded";
    known: InsightUsage;
    missingTaskIds: string[];
    exceeded: string[];
    message: string;
  };
  warnings: string[];
};
export type InsightSimulation = {
  runId: string;
  planVersion: number;
  quantile: number;
  estimates: DurationEstimate[];
  scenarios: ScenarioResult[];
  assumptions: string[];
};
export const getProjectInsights = (pid: string) =>
  api<ProjectInsight>(`${base(pid)}/insights?limit=20`, { cacheTtlMs: false });
export const getRunInsights = (pid: string, rid: string) =>
  api<RunInsight>(`${run(pid, rid)}/insights`, { cacheTtlMs: false });
export const compareRunInsights = (pid: string, left: string, right: string) =>
  api<InsightComparison>(
    `${base(pid)}/runs/compare?left=${seg(left)}&right=${seg(right)}`,
    { cacheTtlMs: false },
  );
export const simulateRun = (
  pid: string,
  rid: string,
  scenarios: InsightScenario[],
  quantile: number,
) =>
  api<InsightSimulation>(`${run(pid, rid)}/simulate`, {
    method: "POST",
    json: { scenarios, quantile },
  });
export async function downloadInsightReport(
  pid: string,
  rid: string,
  format: "json" | "markdown",
) {
  const headers = new Headers({
    Accept: format === "json" ? "application/json" : "text/markdown",
  });
  const session = getSession();
  if (session) headers.set("Authorization", `Bearer ${session}`);
  const response = await fetch(
    `${run(pid, rid)}/insights/report?format=${format}`,
    { headers },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    throw new ApiError(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      response.status,
      body,
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `project-run-${rid}-insights.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
