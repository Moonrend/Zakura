/**
 * Routine 触发器：cron XOR listener。
 * listener 用结构化配置匹配入站事件；具体 HTTP 验签在服务端。
 */

export const ROUTINE_LISTENER_SOURCES = [
  "webhook",
  "slack",
  "github",
  "origin",
  "teams",
  "linear",
  "sentry",
  "pagerduty",
  "group",
] as const;

export type RoutineListenerSource = (typeof ROUTINE_LISTENER_SOURCES)[number];

export const GITHUB_ROUTINE_EVENTS = [
  "pr_opened",
  "pr_pushed",
  "pr_merged",
  "pr_closed",
  "review_requested",
  "approved",
  "changes_requested",
  "review_comment",
  "pr_comment",
  "inline_comment",
  "thread_resolved",
  "thread_reopened",
  "issue_assigned",
  "ci_passed",
  "ci_failed",
] as const;

export type GithubRoutineEvent = (typeof GITHUB_ROUTINE_EVENTS)[number];

export type SlackRoutineMatch = "mention" | "keyword" | "any" | "reaction";

export type SlackListener = {
  source: "slack";
  /** #eng / 频道 id / @name / * */
  channel?: string;
  match: SlackRoutineMatch;
  keywords?: string[];
  emojis?: string[];
  selfOnly?: boolean;
};

export type GithubListener = {
  source: "github" | "origin";
  /** owner/name，不能通配 */
  repo: string;
  events: GithubRoutineEvent[];
  prNumber?: number;
  users?: string[];
  branch?: string;
  /** 命中这些结局后自动停掉这条 routine */
  autoStopOn?: Array<"merged" | "closed">;
};

export type TeamsListener = {
  source: "teams";
  tenantId: string;
  teams: string[];
  channels?: string[];
  contains?: string;
};

export type LinearListener = {
  source: "linear";
  events: Array<"issue_created" | "status_changed" | "cycle_ended">;
  project?: string;
  team?: string;
  status?: string;
  cycle?: string;
};

export type SentryListener = {
  source: "sentry";
  events: Array<"created" | "resolved" | "assigned" | "archived" | "reopened" | "any">;
  project?: string;
};

export type PagerDutyListener = {
  source: "pagerduty";
  events: Array<"triggered" | "acknowledged" | "resolved" | "escalated" | "any">;
  service?: string;
};

export type WebhookListener = {
  source: "webhook";
};

export type GroupListener = {
  source: "group";
  listeners: RoutineListener[];
};

export type RoutineListener =
  | SlackListener
  | GithubListener
  | TeamsListener
  | LinearListener
  | SentryListener
  | PagerDutyListener
  | WebhookListener
  | GroupListener;

/** 归一化后的入站事件，供 matchRoutineListener 使用 */
export type RoutineInboundEvent = {
  source: RoutineListenerSource;
  type: string;
  channel?: string;
  text?: string;
  user?: string;
  emoji?: string;
  mentioned?: boolean;
  repo?: string;
  prNumber?: number;
  branch?: string;
  merged?: boolean;
  action?: string;
  team?: string;
  project?: string;
  status?: string;
  service?: string;
  payload?: unknown;
};

export class RoutineListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineListenerError";
  }
}

const SOURCES = new Set<string>(ROUTINE_LISTENER_SOURCES);
const GH_EVENTS = new Set<string>(GITHUB_ROUTINE_EVENTS);

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Origin 不能和 Teams / Linear / Sentry / PagerDuty / webhook 混在同一 group */
function assertGroupMix(listeners: RoutineListener[]): void {
  const originish = listeners.some((l) => l.source === "origin");
  const blocked = listeners.some(
    (l) =>
      l.source === "teams" ||
      l.source === "linear" ||
      l.source === "sentry" ||
      l.source === "pagerduty" ||
      l.source === "webhook",
  );
  if (originish && blocked) {
    throw new RoutineListenerError(
      "Origin 可和 cron / Slack / GitHub 组合；不要和 Teams / Linear / Sentry / PagerDuty / webhook 混用",
    );
  }
}

export function parseRoutineListener(raw: unknown): RoutineListener {
  const o = obj(raw);
  if (!o) throw new RoutineListenerError("listener 必须是对象");
  const source = asString(o.source);
  if (!SOURCES.has(source)) {
    throw new RoutineListenerError(`未知 listener source: ${source || "(empty)"}`);
  }
  if (source === "slack") {
    const match = asString(o.match) || "any";
    if (!["mention", "keyword", "any", "reaction"].includes(match)) {
      throw new RoutineListenerError(`slack.match 无效: ${match}`);
    }
    if (match === "keyword" && asStringList(o.keywords).length === 0) {
      throw new RoutineListenerError("slack.match=keyword 需要 keywords");
    }
    return {
      source: "slack",
      ...(asString(o.channel) ? { channel: asString(o.channel) } : {}),
      match: match as SlackRoutineMatch,
      ...(asStringList(o.keywords).length ? { keywords: asStringList(o.keywords) } : {}),
      ...(asStringList(o.emojis).length ? { emojis: asStringList(o.emojis) } : {}),
      ...(typeof o.selfOnly === "boolean" ? { selfOnly: o.selfOnly } : {}),
    };
  }
  if (source === "github" || source === "origin") {
    const repo = asString(o.repo);
    if (!repo || repo.includes("*") || !repo.includes("/")) {
      throw new RoutineListenerError("github/origin.repo 必须是 owner/name，不能通配");
    }
    const events = asStringList(o.events).filter((e) => GH_EVENTS.has(e)) as GithubRoutineEvent[];
    if (events.length === 0) throw new RoutineListenerError("github/origin.events 不能为空");
    const autoStopOn = asStringList(o.autoStopOn).filter(
      (e): e is "merged" | "closed" => e === "merged" || e === "closed",
    );
    const prRaw = o.prNumber;
    const prNumber =
      typeof prRaw === "number"
        ? prRaw
        : typeof prRaw === "string" && /^\d+$/.test(prRaw.trim())
          ? Number(prRaw.trim())
          : 0;
    const onlyCi = events.every((e) => e === "ci_passed" || e === "ci_failed");
    const branch = asString(o.branch);
    if (onlyCi && prNumber <= 0 && !branch) {
      throw new RoutineListenerError("github/origin CI 未指定 PR 时必须写 branch（如 main）");
    }
    return {
      source,
      repo,
      events,
      ...(prNumber > 0 ? { prNumber: Math.floor(prNumber) } : {}),
      ...(asStringList(o.users).length ? { users: asStringList(o.users) } : {}),
      ...(branch ? { branch } : {}),
      ...(autoStopOn.length ? { autoStopOn } : {}),
    };
  }
  if (source === "teams") {
    const tenantId = asString(o.tenantId);
    const teams = asStringList(o.teams);
    if (!tenantId || teams.length === 0) {
      throw new RoutineListenerError("teams 需要 tenantId 和至少一个 team");
    }
    return {
      source: "teams",
      tenantId,
      teams,
      ...(asStringList(o.channels).length ? { channels: asStringList(o.channels) } : {}),
      ...(asString(o.contains) ? { contains: asString(o.contains) } : {}),
    };
  }
  if (source === "linear") {
    const events = asStringList(o.events) as LinearListener["events"];
    if (events.length === 0) throw new RoutineListenerError("linear.events 不能为空");
    return {
      source: "linear",
      events,
      ...(asString(o.project) ? { project: asString(o.project) } : {}),
      ...(asString(o.team) ? { team: asString(o.team) } : {}),
      ...(asString(o.status) ? { status: asString(o.status) } : {}),
      ...(asString(o.cycle) ? { cycle: asString(o.cycle) } : {}),
    };
  }
  if (source === "sentry") {
    const events = asStringList(o.events) as SentryListener["events"];
    if (events.length === 0) throw new RoutineListenerError("sentry.events 不能为空");
    return {
      source: "sentry",
      events,
      ...(asString(o.project) ? { project: asString(o.project) } : {}),
    };
  }
  if (source === "pagerduty") {
    const events = asStringList(o.events) as PagerDutyListener["events"];
    if (events.length === 0) throw new RoutineListenerError("pagerduty.events 不能为空");
    return {
      source: "pagerduty",
      events,
      ...(asString(o.service) ? { service: asString(o.service) } : {}),
    };
  }
  if (source === "webhook") return { source: "webhook" };
  const inner = Array.isArray(o.listeners) ? o.listeners.map(parseRoutineListener) : [];
  if (inner.length === 0) throw new RoutineListenerError("group.listeners 不能为空");
  if (inner.some((l) => l.source === "group")) {
    throw new RoutineListenerError("group 不能嵌套 group");
  }
  assertGroupMix(inner);
  return { source: "group", listeners: inner };
}

function norm(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function channelMatches(rule: string | undefined, channel: string | undefined): boolean {
  const r = (rule ?? "*").trim();
  if (!r || r === "*") return true;
  const c = (channel ?? "").trim();
  if (!c) return false;
  const a = r.replace(/^#/, "").toLowerCase();
  const b = c.replace(/^#/, "").toLowerCase();
  return a === b || b.endsWith(`:${a}`) || b.includes(a);
}

function containsKeyword(text: string | undefined, keywords: string[] | undefined): boolean {
  if (!keywords?.length) return true;
  const t = (text ?? "").toLowerCase();
  return keywords.some((k) => k.trim() && t.includes(k.trim().toLowerCase()));
}

function userAllowed(users: string[] | undefined, user: string | undefined): boolean {
  if (!users?.length) return true;
  const u = norm(user);
  return users.some((x) => norm(x) === u);
}

export function matchRoutineListener(
  listener: RoutineListener,
  ev: RoutineInboundEvent,
): boolean {
  if (listener.source === "group") {
    return listener.listeners.some((l) => matchRoutineListener(l, ev));
  }
  if (listener.source === "webhook") return true;
  if (listener.source === "slack") {
    if (ev.source !== "slack") return false;
    if (!channelMatches(listener.channel, ev.channel)) return false;
    if (listener.match === "mention") return ev.mentioned === true || ev.type === "mention";
    if (listener.match === "keyword") return containsKeyword(ev.text, listener.keywords);
    if (listener.match === "reaction") {
      if (ev.type !== "reaction") return false;
      if (listener.emojis?.length) {
        const e = (ev.emoji ?? "").replace(/:/g, "");
        if (!listener.emojis.some((x) => x.replace(/:/g, "") === e)) return false;
      }
      return true;
    }
    return true;
  }
  if (listener.source === "github" || listener.source === "origin") {
    if (ev.source !== "github" && ev.source !== "origin") return false;
    if (norm(ev.repo) !== norm(listener.repo)) return false;
    if (listener.prNumber && ev.prNumber && listener.prNumber !== ev.prNumber) return false;
    if (listener.prNumber && !ev.prNumber) return false;
    if (!userAllowed(listener.users, ev.user)) return false;
    if (listener.branch) {
      if (!ev.branch || norm(listener.branch) !== norm(ev.branch)) return false;
    }
    return listener.events.includes(ev.type as GithubRoutineEvent);
  }
  if (listener.source === "teams") {
    if (ev.source !== "teams") return false;
    if (listener.tenantId && ev.payload) {
      /* tenant 由 webhook 路由侧保证 */
    }
    if (listener.teams.length && ev.team && !listener.teams.some((t) => norm(t) === norm(ev.team))) {
      return false;
    }
    if (listener.channels?.length && !listener.channels.some((c) => channelMatches(c, ev.channel))) {
      return false;
    }
    if (listener.contains && !containsKeyword(ev.text, [listener.contains])) return false;
    return true;
  }
  if (listener.source === "linear") {
    if (ev.source !== "linear") return false;
    if (!listener.events.includes(ev.type as LinearListener["events"][number])) return false;
    if (listener.project && ev.project && norm(listener.project) !== norm(ev.project)) return false;
    if (listener.team && ev.team && norm(listener.team) !== norm(ev.team)) return false;
    if (listener.status && ev.status && norm(listener.status) !== norm(ev.status)) return false;
    return true;
  }
  if (listener.source === "sentry") {
    if (ev.source !== "sentry") return false;
    if (listener.events.includes("any")) return true;
    return listener.events.includes(ev.type as SentryListener["events"][number]);
  }
  if (listener.source === "pagerduty") {
    if (ev.source !== "pagerduty") return false;
    if (listener.events.includes("any")) return true;
    return listener.events.includes(ev.type as PagerDutyListener["events"][number]);
  }
  return false;
}

function strField(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function nested(o: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let cur: unknown = o;
  for (const p of path) {
    const next = obj(cur)?.[p];
    cur = next;
  }
  return obj(cur);
}

function numField(o: Record<string, unknown> | null, key: string): number | undefined {
  if (!o) return undefined;
  const v = o[key];
  if (typeof v === "number" && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function firstPrNumber(...lists: unknown[]): number | undefined {
  for (const list of lists) {
    if (!Array.isArray(list) || !list[0]) continue;
    const n = numField(obj(list[0]), "number");
    if (n) return n;
  }
  return undefined;
}

function githubHeadBranch(payload: Record<string, unknown>, pr: Record<string, unknown> | null): string {
  const fromPr =
    (pr?.head && typeof pr.head === "object"
      ? asString((pr.head as Record<string, unknown>).ref)
      : "") ||
    (pr?.base && typeof pr.base === "object"
      ? asString((pr.base as Record<string, unknown>).ref)
      : "");
  return (
    strField(payload, "ref")?.replace(/^refs\/heads\//, "") ||
    asString(obj(payload.workflow_run)?.head_branch) ||
    asString(obj(payload.check_suite)?.head_branch) ||
    asString(obj(payload.check_run)?.head_branch) ||
    fromPr
  );
}

/** GitHub webhook → 归一化事件（可能一次 webhook 对应 0~n 个业务 type） */
export function inboundFromGithub(
  eventName: string,
  payload: Record<string, unknown>,
): RoutineInboundEvent[] {
  const repoObj = obj(payload.repository);
  const repo =
    strField(payload, "repository") ||
    (typeof repoObj?.full_name === "string" ? repoObj.full_name : "") ||
    "";
  const pr = obj(payload.pull_request) ?? nested(payload, ["issue", "pull_request"]) ?? obj(payload.issue);
  const prNumber =
    numField(pr, "number") ??
    numField(obj(payload), "number") ??
    firstPrNumber(
      payload.pull_requests,
      obj(payload.workflow_run)?.pull_requests,
      obj(payload.check_suite)?.pull_requests,
      obj(payload.check_run)?.pull_requests,
    );
  const userObj = obj(payload.sender) ?? obj(payload.pusher);
  const user = typeof userObj?.login === "string" ? userObj.login : undefined;
  const merged = pr?.merged === true;
  const action = asString(payload.action);
  const branch = githubHeadBranch(payload, pr) || undefined;

  const base = (): RoutineInboundEvent => ({
    source: "github",
    type: "",
    repo,
    ...(prNumber ? { prNumber } : {}),
    ...(user ? { user } : {}),
    ...(branch ? { branch } : {}),
    ...(merged ? { merged: true } : {}),
    ...(action ? { action } : {}),
    payload,
  });

  const types: GithubRoutineEvent[] = [];
  const ev = eventName.trim();
  if (ev === "pull_request") {
    if (action === "opened" || action === "reopened") types.push("pr_opened");
    if (action === "synchronize") types.push("pr_pushed");
    if (action === "closed" && merged) types.push("pr_merged", "pr_closed");
    else if (action === "closed") types.push("pr_closed");
    if (action === "review_requested") types.push("review_requested");
    if (action === "assigned") types.push("issue_assigned");
  } else if (ev === "pull_request_review") {
    const review = obj(payload.review);
    const state = asString(review?.state).toLowerCase();
    if (state === "approved") types.push("approved");
    if (state === "changes_requested") types.push("changes_requested");
    types.push("review_comment");
  } else if (ev === "pull_request_review_comment") {
    types.push("inline_comment");
  } else if (ev === "issue_comment") {
    types.push("pr_comment");
  } else if (ev === "pull_request_review_thread") {
    if (action === "resolved") types.push("thread_resolved");
    if (action === "unresolved") types.push("thread_reopened");
  } else if (ev === "issues" && action === "assigned") {
    types.push("issue_assigned");
  } else if (ev === "check_suite" || ev === "check_run" || ev === "workflow_run" || ev === "workflow_job") {
    const conclusion = asString(
      strField(payload, "conclusion") ||
        (typeof obj(payload.check_suite)?.conclusion === "string"
          ? String(obj(payload.check_suite)!.conclusion)
          : "") ||
        (typeof obj(payload.check_run)?.conclusion === "string"
          ? String(obj(payload.check_run)!.conclusion)
          : "") ||
        (typeof obj(payload.workflow_run)?.conclusion === "string"
          ? String(obj(payload.workflow_run)!.conclusion)
          : "") ||
        (typeof obj(payload.workflow_job)?.conclusion === "string"
          ? String(obj(payload.workflow_job)!.conclusion)
          : ""),
    ).toLowerCase();
    const status = asString(
      obj(payload.workflow_run)?.status ?? obj(payload.check_suite)?.status ?? "",
    ).toLowerCase();
    if (conclusion === "success") types.push("ci_passed");
    if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") {
      types.push("ci_failed");
    }
    if (!conclusion && status === "completed") {
      /* ignore */
    }
  } else if (ev === "push") {
    types.push("pr_pushed");
  }

  return types.map((type) => ({ ...base(), type }));
}

export function inboundFromLinear(payload: Record<string, unknown>): RoutineInboundEvent | null {
  const action = asString(payload.action) || asString(payload.type);
  const typeMap: Record<string, LinearListener["events"][number]> = {
    create: "issue_created",
    created: "issue_created",
    "Issue.create": "issue_created",
    update: "status_changed",
    updated: "status_changed",
    "Issue.update": "status_changed",
    cycle_ended: "cycle_ended",
    "Cycle.update": "cycle_ended",
  };
  const mapped = typeMap[action];
  if (!mapped) return null;
  const data = obj(payload.data) ?? payload;
  return {
    source: "linear",
    type: mapped,
    project: asString(data.projectId) || asString(data.project),
    team: asString(data.teamId) || asString(data.team),
    status: asString(data.stateId) || asString(data.status),
    payload,
  };
}

export function inboundFromSentry(payload: Record<string, unknown>): RoutineInboundEvent | null {
  const action = asString(payload.action) || asString(payload.resource);
  const typeMap: Record<string, SentryListener["events"][number]> = {
    created: "created",
    resolved: "resolved",
    assigned: "assigned",
    archived: "archived",
    unresolved: "reopened",
    reopened: "reopened",
  };
  const mapped = typeMap[action] ?? "any";
  const data = obj(payload.data) ?? payload;
  const project = obj(data.issue) ?? obj(payload.project) ?? data;
  return {
    source: "sentry",
    type: mapped,
    project: asString(project.project) || asString(project.slug) || asString(payload.project_slug),
    payload,
  };
}

export function inboundFromPagerDuty(payload: Record<string, unknown>): RoutineInboundEvent | null {
  const event = obj(payload.event) ?? payload;
  const eventType = asString(event.event_type) || asString(payload.event_type);
  const typeMap: Record<string, PagerDutyListener["events"][number]> = {
    "incident.triggered": "triggered",
    "incident.acknowledged": "acknowledged",
    "incident.resolved": "resolved",
    "incident.escalated": "escalated",
    triggered: "triggered",
    acknowledged: "acknowledged",
    resolved: "resolved",
    escalated: "escalated",
  };
  const mapped = typeMap[eventType] ?? "any";
  const service = obj(obj(event.data)?.service ?? obj(payload.service));
  return {
    source: "pagerduty",
    type: mapped,
    service: asString(service?.id) || asString(service?.summary),
    payload,
  };
}

export function inboundFromTeams(payload: Record<string, unknown>): RoutineInboundEvent {
  return {
    source: "teams",
    type: "message",
    team: asString(payload.teamId) || asString(payload.team),
    channel: asString(payload.channelId) || asString(payload.channel),
    text: asString(payload.text) || asString(obj(payload.body)?.content),
    payload,
  };
}

export function inboundFromSlack(input: {
  channel?: string;
  text?: string;
  user?: string;
  mentioned?: boolean;
  emoji?: string;
  type?: string;
}): RoutineInboundEvent {
  return {
    source: "slack",
    type: input.emoji ? "reaction" : input.mentioned ? "mention" : (input.type ?? "message"),
    channel: input.channel,
    text: input.text,
    user: input.user,
    emoji: input.emoji,
    mentioned: input.mentioned,
  };
}

export function shouldAutoStopListener(
  listener: RoutineListener,
  ev: RoutineInboundEvent,
): boolean {
  if (listener.source === "group") {
    return listener.listeners.some((l) => shouldAutoStopListener(l, ev));
  }
  if (listener.source !== "github" && listener.source !== "origin") return false;
  const stop = listener.autoStopOn ?? [];
  if (ev.type === "pr_merged" && (stop.includes("merged") || stop.length === 0)) {
    // 带合并的「盯某个 PR」默认跑完就停
    return Boolean(listener.prNumber) || stop.includes("merged");
  }
  if (ev.type === "pr_closed" && (stop.includes("closed") || listener.prNumber)) {
    return true;
  }
  return false;
}

export function describeListener(listener: RoutineListener): string {
  if (listener.source === "webhook") return "Webhook";
  if (listener.source === "slack") {
    const ch = listener.channel && listener.channel !== "*" ? listener.channel : "已加入的频道";
    const m =
      listener.match === "mention"
        ? "被 @"
        : listener.match === "keyword"
          ? `关键词 ${listener.keywords?.join("/") ?? ""}`
          : listener.match === "reaction"
            ? "表情反应"
            : "任意消息";
    return `Slack ${ch} · ${m}`;
  }
  if (listener.source === "github" || listener.source === "origin") {
    const who = listener.source === "origin" ? "Origin" : "GitHub";
    const pr = listener.prNumber ? ` #${listener.prNumber}` : "";
    return `${who} ${listener.repo}${pr} · ${listener.events.join(", ")}`;
  }
  if (listener.source === "teams") return `Teams · ${listener.teams.join(", ")}`;
  if (listener.source === "linear") return `Linear · ${listener.events.join(", ")}`;
  if (listener.source === "sentry") return `Sentry · ${listener.events.join(", ")}`;
  if (listener.source === "pagerduty") return `PagerDuty · ${listener.events.join(", ")}`;
  if (listener.source === "group") {
    return listener.listeners.map(describeListener).join(" 或 ");
  }
  return "事件触发";
}

export function summarizeInbound(ev: RoutineInboundEvent): string {
  const bits = [ev.source, ev.type];
  if (ev.repo) bits.push(ev.repo);
  if (ev.prNumber) bits.push(`#${ev.prNumber}`);
  if (ev.channel) bits.push(ev.channel);
  if (ev.user) bits.push(`by ${ev.user}`);
  return bits.filter(Boolean).join(" · ");
}
