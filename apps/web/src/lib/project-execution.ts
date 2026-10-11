"use client";

import { api, ApiError } from "@/lib/api";

export type Budget = {
  maxTokens: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallSeconds: number;
  maxConcurrent: number;
};
export type ProjectConfig = {
  budget: Budget;
  requireReview: boolean;
  externalEffects: "deny" | "review" | "allow";
  maxTasks: number;
};
export type CheckKind =
  | "path_exists"
  | "path_absent"
  | "text_contains"
  | "text_excludes"
  | "regex"
  | "json_valid"
  | "json_pointer"
  | "command";
export type CheckSpec = {
  id: string;
  kind: CheckKind;
  title: string;
  path?: string;
  pattern?: string;
  command?: string[];
  timeoutSeconds?: number;
  expectedExitCode?: number;
  required: boolean;
};
export type TaskSpec = {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  model?: string;
  dependsOn: string[];
  writes: string[];
  priority: number;
  maxAttempts: number;
  checks: CheckSpec[];
};
export type Plan = { version: number; tasks: TaskSpec[] };
export type Definition = {
  spaceId: string;
  name: string;
  goal: string;
  plan: Plan;
  config: ProjectConfig;
  expectedRevision?: number;
};
export type Project = Definition & {
  id: string;
  tenantId: string;
  status: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type Issue = {
  code: string;
  taskId?: string;
  checkId?: string;
  field: string;
  message: string;
  related?: string[];
};
export type GraphNode = {
  id: string;
  title: string;
  agentId: string;
  layer: number;
  order: number;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  slack: number;
  critical: boolean;
  ancestors: number;
  descendants: number;
  x: number;
  y: number;
};
export type Analysis = {
  planVersion: number;
  topological: string[];
  roots: string[];
  leaves: string[];
  nodes: GraphNode[];
  edges: { from: string; to: string; critical: boolean }[];
  criticalPath: string[];
  criticalLength: number;
  maxLayerWidth: number;
  layers: string[][];
  requiredChecks: number;
  conflicts: {
    leftTask: string;
    rightTask: string;
    leftPath: string;
    rightPath: string;
    ordered: boolean;
    witness: string;
  }[];
  warnings: Issue[];
};
export type Run = {
  id: string;
  projectId: string;
  status: string;
  revision: number;
  planVersion: number;
  baseSnapshot: string;
  tokens: number;
  modelCalls: number;
  toolCalls: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type Task = {
  id: string;
  runId: string;
  spec: TaskSpec;
  status: string;
  attempt: number;
  revision: number;
  sessionId: string;
  branchId: string;
  baseSnapshot?: string;
  forkSnapshotId?: string;
  snapshotId: string;
  checkpointId: string;
  leaseOwner?: string;
  leaseUntil?: string;
  fence: number;
  reusedFromRunId?: string;
  reusedFromTaskId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type Operation = {
  id: string;
  taskId: string;
  checkpointId: string;
  status: string;
  call: { id: string; name: string; arguments: unknown; effect: string };
  argumentsHash: string;
  result?: unknown;
  error?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type Evidence = {
  version: number;
  snapshotId: string;
  checkId: string;
  specHash: string;
  status: string;
  path?: string;
  exists?: boolean;
  size?: number;
  contentHash?: string;
  outputHash?: string;
  proofHash: string;
  resultHash: string;
  networkDisabled?: boolean;
  truncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  exitCode?: number;
  detail?: string;
};
export type CheckResult = {
  id: string;
  kind: string;
  status: string;
  summary: string;
  output?: string;
  durationMs: number;
  required: boolean;
  evidence?: Evidence;
};
export type Verification = {
  id: string;
  taskId: string;
  branchId: string;
  snapshotId: string;
  status: string;
  checks: CheckResult[];
  createdAt: string;
};
export type Review = {
  id: string;
  taskId: string;
  snapshotId: string;
  decision: string;
  authorId: string;
  comment: string;
  createdAt: string;
};
export type Checkpoint = {
  id: string;
  taskId: string;
  sequence: number;
  messages: Record<string, unknown>[];
  decision?: {
    message: Record<string, unknown>;
    tools: unknown[];
    done: boolean;
    result: string;
    tokens: number;
  };
  nextTool: number;
  context?: unknown;
  createdAt: string;
};
export type TaskDetail = {
  task: Task;
  checkpoint?: Checkpoint | null;
  operations: Operation[];
  verifications: Verification[];
  reviews: Review[];
};
export type Event = {
  id: string;
  projectId: string;
  runId?: string;
  taskId?: string;
  sequence: number;
  kind: string;
  payload: unknown;
  createdAt: string;
};
export type Branch = {
  id: string;
  base: string;
  head: string;
  generation: number;
  updatedAt: string;
};
export type FileEntry = {
  path: string;
  name?: string;
  size: number;
  isDir?: boolean;
  hash?: string;
};
export type FilePreview = {
  snapshotId?: string;
  branchId?: string;
  path: string;
  content: string;
  base64?: string;
  size: number;
  revision: string;
};
export type ArtifactChange = {
  kind: string;
  path: string;
  oldPath?: string;
  before?: { hash: string; size: number };
  after?: { hash: string; size: number };
};
export type ReplanReport = {
  changes: {
    taskId: string;
    kind: string;
    fields: string[];
    executionChanged: boolean;
    acceptanceChanged: boolean;
  }[];
  added: string[];
  removed: string[];
  invalidated: string[];
  retained: string[];
  interrupted: string[];
  replayRequired: string[];
  reasons: Record<string, string[]>;
  safeToApply: boolean;
  analysis: Analysis;
};
export type Comparison = {
  base: Record<string, number | Record<string, number>>;
  candidate: Record<string, number | Record<string, number>>;
  metrics: {
    name: string;
    base: number;
    candidate: number;
    delta: number;
    weight: number;
    explanation: string;
  }[];
  recommendation: string;
  comparable: boolean;
  uncertainty: string[];
};
export type Schedule = {
  selected: { taskId: string; score: number; reasons: string[] }[];
  ranked: {
    taskId: string;
    score: number;
    priorityScore: number;
    criticalScore: number;
    agingScore: number;
    fairnessPenalty: number;
    reasons: string[];
  }[];
  deferred: {
    taskId: string;
    codes: string[];
    detail: string;
    related?: string[];
  }[];
  active: string[];
  availableSlots: number;
  warnings: Issue[];
  reserved: {
    tokens: number;
    modelCalls: number;
    toolCalls: number;
    wallSeconds: number;
  };
};
export type SourceActivity = {
  id: string;
  spaceId: string;
  status: "current" | "orphaned";
  runtimeLive: boolean;
  startedAt: string;
  updatedAt: string;
};
export type SourceAttestation = {
  id: string;
  authorId: string;
  activityIds: string[];
  comment: string;
  status: "pending" | "confirmed" | "unknown" | "failed" | "superseded";
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type SourceInspection = {
  id: string;
  status: SourceAttestation["status"];
  inspection?: {
    known: boolean;
    status: string;
    result?: unknown;
    error?: string;
  };
};

const segment = (value: string) => encodeURIComponent(value);
export const projectPath = (id: string) =>
  `/api/project-executions/${segment(id)}`;
export const runPath = (pid: string, rid: string) =>
  `${projectPath(pid)}/runs/${segment(rid)}`;
export function getSourceActivities(pid: string) {
  return api<{ activities: SourceActivity[] }>(
    `${projectPath(pid)}/source/activities`,
    { cacheTtlMs: false },
  );
}
export function getSourceAttestations(pid: string) {
  return api<{ items: SourceAttestation[] }>(
    `${projectPath(pid)}/source/attestations`,
    { cacheTtlMs: false },
  );
}
export function confirmSourceQuiescence(
  pid: string,
  activityIds: string[],
  comment: string,
) {
  return api<SourceAttestation>(`${projectPath(pid)}/source/quiescence`, {
    method: "POST",
    json: { activityIds, confirmation: "writers_stopped", comment },
  });
}
export function inspectSourceAttestation(pid: string, id: string) {
  return api<SourceInspection>(
    `${projectPath(pid)}/source/attestations/${segment(id)}/inspect`,
    { method: "POST" },
  );
}
export function getProjects(spaceId = "") {
  return api<{ items: Project[] }>(
    `/api/project-executions/?spaceId=${segment(spaceId)}`,
    { cacheTtlMs: false },
  );
}
export function getProject(id: string) {
  return api<{ project: Project; analysis: Analysis }>(`${projectPath(id)}/`, {
    cacheTtlMs: false,
  });
}
export function createProject(value: Definition) {
  return api<Project>("/api/project-executions/", {
    method: "POST",
    json: value,
  });
}
export function updateProject(id: string, value: Definition) {
  return api<Project>(`${projectPath(id)}/`, { method: "PATCH", json: value });
}
export function deleteProject(id: string, revision: number) {
  return api(`${projectPath(id)}/`, {
    method: "DELETE",
    json: { expectedRevision: revision },
  });
}
export function validatePlan(id: string, value: Definition) {
  return api<Analysis>(`${projectPath(id)}/plan/validate`, {
    method: "POST",
    json: { plan: value.plan, config: value.config },
  });
}
export function comparePlan(id: string, value: Definition) {
  return api<Comparison>(`${projectPath(id)}/plan/compare`, {
    method: "POST",
    json: { plan: value.plan, config: value.config },
  });
}
export function replan(id: string, value: Definition, runId?: string) {
  return api<ReplanReport>(`${projectPath(id)}/plan/replan`, {
    method: "POST",
    json: { plan: value.plan, config: value.config, runId },
  });
}
export function getRuns(id: string) {
  return api<{ items: Run[] }>(`${projectPath(id)}/runs`, {
    cacheTtlMs: false,
  });
}
export function getRun(pid: string, rid: string) {
  return api<{
    run: Run;
    tasks: Task[];
    project: Project;
    analysis?: Analysis;
  }>(`${runPath(pid, rid)}/`, { cacheTtlMs: false });
}
export function startRun(pid: string, revision: number) {
  return api<Run>(`${projectPath(pid)}/runs`, {
    method: "POST",
    json: { expectedRevision: revision },
  });
}
export function controlRun(
  pid: string,
  run: Run,
  action: "pause" | "resume" | "cancel",
) {
  return api<Run>(`${runPath(pid, run.id)}/${action}`, {
    method: "POST",
    json: { expectedRevision: run.revision },
  });
}
export function getTask(pid: string, rid: string, tid: string) {
  return api<TaskDetail>(`${runPath(pid, rid)}/tasks/${segment(tid)}`, {
    cacheTtlMs: false,
  });
}
export function retryTask(pid: string, rid: string, task: Task) {
  return api<Task>(`${runPath(pid, rid)}/tasks/${segment(task.id)}/retry`, {
    method: "POST",
    json: { expectedRevision: task.revision },
  });
}
export function reviewTask(
  pid: string,
  rid: string,
  tid: string,
  snapshotId: string,
  decision: "approve" | "reject",
  comment: string,
) {
  return api<Review>(`${runPath(pid, rid)}/tasks/${segment(tid)}/reviews`, {
    method: "POST",
    json: { snapshotId, decision, comment },
  });
}
export function resolveOperation(
  pid: string,
  rid: string,
  operation: Operation,
  decision: "approved" | "denied" | "completed" | "failed" | "not_performed",
  comment: string,
  result?: unknown,
  error?: string,
) {
  return api<Operation>(
    `${runPath(pid, rid)}/operations/${segment(operation.id)}/resolve`,
    {
      method: "POST",
      json: {
        expectedRevision: operation.revision,
        decision,
        comment,
        result,
        error,
      },
    },
  );
}
export function getEvents(
  pid: string,
  after = 0,
  runId = "",
  signal?: AbortSignal,
) {
  return api<{ items: Event[]; cursor: number }>(
    `${projectPath(pid)}/events?after=${after}&runId=${segment(runId)}&limit=200`,
    { cacheTtlMs: false, signal },
  );
}
export function getSchedule(pid: string, rid: string) {
  return api<Schedule>(`${runPath(pid, rid)}/schedule`, { cacheTtlMs: false });
}
export function getBranches(pid: string) {
  return api<{ branches: Branch[] }>(`${projectPath(pid)}/branches`, {
    cacheTtlMs: false,
  });
}
export function getBranchFiles(pid: string, bid: string, path = "") {
  return api<{ entries: FileEntry[] }>(
    `${projectPath(pid)}/branches/${segment(bid)}/files?path=${segment(path)}`,
    { cacheTtlMs: false },
  );
}
export function getArtifactFile(
  pid: string,
  source: { snapshotId: string } | { branchId: string },
  path: string,
) {
  const route =
    "snapshotId" in source
      ? `snapshots/${segment(source.snapshotId)}`
      : `branches/${segment(source.branchId)}`;
  return api<FilePreview>(
    `${projectPath(pid)}/${route}/file?path=${segment(path)}`,
    { cacheTtlMs: false },
  );
}
export function compareTasks(
  pid: string,
  rid: string,
  leftTask: string,
  rightTask: string,
) {
  return api<{
    left: Task;
    right: Task;
    diff: ArtifactChange[];
    leftVerifications: Verification[];
    rightVerifications: Verification[];
  }>(
    `${runPath(pid, rid)}/compare?leftTask=${segment(leftTask)}&rightTask=${segment(rightTask)}`,
    { cacheTtlMs: false },
  );
}
export function friendlyError(error: unknown) {
  if (error instanceof ApiError) {
    const issues = error.body.issues as Issue[] | undefined;
    if (Array.isArray(issues))
      return issues
        .map(
          (i) =>
            `${i.taskId ? `任务 ${i.taskId} · ` : ""}${i.checkId ? `验收 ${i.checkId} · ` : ""}${i.field}: ${i.message}`,
        )
        .join("\n");
    if (error.status === 409)
      return `数据已变更或当前状态不允许此操作，请刷新后重试。${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : "请求失败";
}
export const CHECK_LABELS: Record<CheckKind, string> = {
  path_exists: "路径存在",
  path_absent: "路径不存在",
  text_contains: "包含指定文本",
  text_excludes: "不含指定文本",
  regex: "正则匹配",
  json_valid: "JSON 有效",
  json_pointer: "JSON 字段验收",
  command: "隔离命令退出码",
};
const STATUS_LABELS: Record<string, string> = {
  confirmed: "已确认旧写入停止",
  superseded: "已由后续确认核清",
  pending: "等待执行",
  running: "执行中",
  paused: "已暂停",
  verifying: "验收中",
  waiting_review: "等待审核",
  waiting_approval: "等待授权",
  unknown: "执行结果待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  blocked: "依赖受阻",
  passed: "通过",
  error: "错误",
  unverified: "未验证",
  approved: "已批准",
  rejected: "已拒绝",
  pending_approval: "等待授权",
  prepared: "已记录待执行",
  executing: "执行中",
  applied: "已合并",
  ready: "可审核",
  conflicted: "存在冲突",
  verification_failed: "合并验收失败",
  applying: "正在合并",
  abandoned: "已放弃",
  draft: "计划草稿",
  active: "持续执行中",
};
export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}
export function defaultDefinition(spaceId = "", agentId = ""): Definition {
  return {
    spaceId,
    name: "",
    goal: "",
    plan: { version: 1, tasks: [newTask(agentId)] },
    config: {
      budget: {
        maxTokens: 200000,
        maxModelCalls: 100,
        maxToolCalls: 500,
        maxWallSeconds: 86400,
        maxConcurrent: 2,
      },
      requireReview: true,
      externalEffects: "review",
      maxTasks: 1000,
    },
  };
}
export function newTask(agentId = ""): TaskSpec {
  const id = `task_${globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ?? Date.now().toString(36)}`;
  return {
    id,
    title: "",
    prompt: "",
    agentId,
    dependsOn: [],
    writes: [],
    priority: 0,
    maxAttempts: 3,
    checks: [newCheck()],
  };
}
export function newCheck(): CheckSpec {
  return {
    id: `check_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36)}`,
    kind: "path_exists",
    title: "",
    path: "",
    required: true,
  };
}
export function validateDraft(value: Definition): string[] {
  const problems: string[] = [];
  if (!value.name.trim()) problems.push("请填写项目名称");
  if (!value.goal.trim()) problems.push("请填写可交付的项目目标");
  if (!value.spaceId) problems.push("请选择所属空间");
  if (!value.plan.tasks.length) problems.push("至少需要一个任务");
  const ids = new Set(value.plan.tasks.map((t) => t.id));
  for (const task of value.plan.tasks) {
    const name = task.title || task.id;
    if (!task.title.trim() || !task.prompt.trim())
      problems.push(`${name}：请填写标题与执行要求`);
    if (!task.agentId) problems.push(`${name}：请选择执行 Agent`);
    if (!task.checks.some((c) => c.required))
      problems.push(`${name}：至少设置一个必需验收条件`);
    for (const dependency of task.dependsOn)
      if (!ids.has(dependency) || dependency === task.id)
        problems.push(`${name}：依赖无效 ${dependency}`);
    for (const check of task.checks) {
      if (check.kind !== "command" && !check.path?.trim())
        problems.push(`${name}：验收 ${check.title || check.id} 缺少相对路径`);
      if (check.kind === "command" && !check.command?.[0]?.trim())
        problems.push(`${name}：验收命令缺少程序名`);
      if (
        ["text_contains", "text_excludes", "regex"].includes(check.kind) &&
        !check.pattern
      )
        problems.push(`${name}：验收 ${check.title || check.id} 缺少匹配条件`);
    }
  }
  return problems;
}

export type MergeConflict = {
  id: string;
  kind: string;
  path: string;
  preview?: string;
  source?: string;
  base?: FileEntry;
  ours?: FileEntry;
  theirs?: FileEntry;
};
export type MergeResolution = {
  conflictId: string;
  choice: "ours" | "theirs" | "base" | "delete" | "content";
  content?: string;
  destination?: string;
  mode?: number;
};
export type MergePreview = {
  id: string;
  projectId: string;
  runId: string;
  revision: number;
  runRevision: number;
  status: string;
  planId: string;
  plan: {
    id: string;
    base: string;
    ours: string;
    theirs: string;
    result: { id: string; entries: FileEntry[]; totalBytes: number };
    conflicts: MergeConflict[];
  };
  expectedBase: string;
  taskSnapshots: Record<string, string>;
  verifications: Verification[];
  reviewId?: string;
  reviewedBy?: string;
  reviewComment?: string;
  operationId?: string;
  result?: unknown;
  error?: string;
  originalPreviewId?: string;
  createdAt: string;
  updatedAt: string;
};
export function getMerges(pid: string, rid: string) {
  return api<{ items: MergePreview[] }>(`${runPath(pid, rid)}/merges`, {
    cacheTtlMs: false,
  });
}
export function getMerge(pid: string, rid: string, mid: string) {
  return api<{
    preview: MergePreview;
    audit: {
      id: string;
      authorId: string;
      action: string;
      snapshotId: string;
      comment: string;
      createdAt: string;
    }[];
  }>(`${runPath(pid, rid)}/merges/${segment(mid)}`, { cacheTtlMs: false });
}
export function previewMerge(pid: string, run: Run, taskIds: string[]) {
  return api<MergePreview>(`${runPath(pid, run.id)}/merges/preview`, {
    method: "POST",
    json: { expectedRunRevision: run.revision, taskIds },
  });
}
export function resolveMerge(
  pid: string,
  preview: MergePreview,
  resolutions: MergeResolution[],
) {
  return api<MergePreview>(
    `${runPath(pid, preview.runId)}/merges/${segment(preview.id)}/resolve`,
    {
      method: "POST",
      json: { expectedRevision: preview.revision, resolutions },
    },
  );
}
export function reviewMerge(
  pid: string,
  preview: MergePreview,
  decision: "approved" | "rejected",
  comment: string,
) {
  return api<MergePreview>(
    `${runPath(pid, preview.runId)}/merges/${segment(preview.id)}/review`,
    {
      method: "POST",
      json: {
        expectedRevision: preview.revision,
        snapshotId: preview.plan.result.id,
        decision,
        comment,
      },
    },
  );
}
export function applyMerge(pid: string, preview: MergePreview) {
  return api<MergePreview>(
    `${runPath(pid, preview.runId)}/merges/${segment(preview.id)}/apply`,
    {
      method: "POST",
      json: { expectedRevision: preview.revision, confirmation: "merge" },
    },
  );
}
export function reconcileMerge(
  pid: string,
  preview: MergePreview,
  decision: "inspect" | "not_performed",
  comment: string,
) {
  return api<MergePreview>(
    `${runPath(pid, preview.runId)}/merges/${segment(preview.id)}/reconcile`,
    {
      method: "POST",
      json: { expectedRevision: preview.revision, decision, comment },
    },
  );
}
export function utf8Base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function forkRun(pid: string, rid: string, projectRevision: number) {
  return api<Run>(`${runPath(pid, rid)}/fork`, {
    method: "POST",
    json: { expectedProjectRevision: projectRevision },
  });
}
