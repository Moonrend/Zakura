import { api } from "@/lib/api";
import type {
  UserUsageEventDto,
  UserUsageSessionRowDto,
  UserUsageSummaryDto,
  UserUsageTenantRowDto,
} from "@zakura/shared";

export type UserUsageBundle = {
  summary: UserUsageSummaryDto;
  events: UserUsageEventDto[];
  eventTotal: number;
  sessions: UserUsageSessionRowDto[];
};

export async function fetchMyUsage(days = 30): Promise<UserUsageBundle> {
  return api<UserUsageBundle>(`/api/usage/me?days=${days}`, { cacheTtlMs: false });
}

export async function fetchUserUsage(
  userId: string,
  opts?: { days?: number; scope?: "tenant" | "all" },
): Promise<UserUsageBundle> {
  const days = opts?.days ?? 30;
  const scope = opts?.scope === "all" ? "&scope=all" : "";
  return api<UserUsageBundle>(`/api/usage/users/${userId}?days=${days}${scope}`, {
    cacheTtlMs: false,
  });
}

export async function fetchTenantUsage(days = 30): Promise<{
  days: number;
  users: UserUsageTenantRowDto[];
}> {
  return api(`/api/usage/users?days=${days}`, { cacheTtlMs: false });
}

export const USAGE_ACTION_LABEL: Record<string, string> = {
  login: "登录",
  session_created: "新建会话",
  run_started: "开始回合",
  run_completed: "回合完成",
  run_failed: "回合失败",
  run_cancelled: "回合取消",
  tool_called: "工具调用",
};

export const USAGE_CATEGORY_LABEL: Record<string, string> = {
  auth: "登录",
  session: "会话",
  run: "回合",
  tool: "工具",
  admin: "管理",
};
