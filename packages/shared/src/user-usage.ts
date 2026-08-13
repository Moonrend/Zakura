/** User-scoped usage telemetry (product data plane, not stdout). */

export const USER_USAGE_CATEGORIES = [
  "auth",
  "session",
  "run",
  "tool",
  "admin",
] as const;
export type UserUsageCategory = (typeof USER_USAGE_CATEGORIES)[number];

export const USER_USAGE_ACTIONS = [
  "login",
  "session_created",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "tool_called",
] as const;
export type UserUsageAction = (typeof USER_USAGE_ACTIONS)[number];

export const USER_USAGE_ACTOR_KINDS = ["user", "api_key", "system"] as const;
export type UserUsageActorKind = (typeof USER_USAGE_ACTOR_KINDS)[number];

export function isUserUsageCategory(v: string): v is UserUsageCategory {
  return (USER_USAGE_CATEGORIES as readonly string[]).includes(v);
}

export function isUserUsageAction(v: string): v is UserUsageAction {
  return (USER_USAGE_ACTIONS as readonly string[]).includes(v);
}

export type UserUsageEventDto = {
  id: string;
  tenantId: string;
  userId: string;
  actorKind: UserUsageActorKind;
  category: UserUsageCategory;
  action: UserUsageAction;
  status: "ok" | "error";
  durationMs: number;
  agentId: string | null;
  sessionId: string | null;
  resourceKind: string | null;
  resourceId: string | null;
  summary: string;
  createdAt: string;
};

export type UserUsageDayDto = {
  day: string;
  logins: number;
  sessionsStarted: number;
  runsOk: number;
  runsError: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
  lastSeenAt: string | null;
};

export type UserUsageSummaryDto = {
  userId: string;
  tenantId: string | null;
  lastSeenAt: string | null;
  days: number;
  totals: {
    logins: number;
    sessionsStarted: number;
    runsOk: number;
    runsError: number;
    toolCalls: number;
    toolErrors: number;
    durationMs: number;
  };
  series: UserUsageDayDto[];
};

export type UserUsageTenantRowDto = {
  userId: string;
  email: string;
  name: string | null;
  lastSeenAt: string | null;
  logins: number;
  sessionsStarted: number;
  runsOk: number;
  runsError: number;
  toolCalls: number;
};

export type UserUsageSessionRowDto = {
  id: string;
  tenantId: string;
  agentId: string;
  title: string;
  kind: string;
  status: string;
  updatedAt: string;
};