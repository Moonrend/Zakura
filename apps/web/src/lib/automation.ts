/**
 * Agent 自动化：定时任务 API 与人话文案。
 * 原则：用户看到的是「什么时候做什么」，不先学 cron。
 */
import { api } from "@/lib/api";

export type AgentSchedule = {
  id: string;
  agentId: string;
  name: string;
  description: string;
  pattern: string;
  prompt: string;
  enabled: boolean;
  maxRuns: number | null;
  runCount: number;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  id: string;
  agentId: string;
  kind: "schedule" | "heartbeat";
  scheduleId: string | null;
  sessionId: string | null;
  cloudRunId: string | null;
  status: string;
  prompt: string;
  resultText: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type WhenPresetId =
  | "every_15m"
  | "every_30m"
  | "every_1h"
  | "every_6h"
  | "daily_morning"
  | "daily_evening"
  | "weekdays_morning"
  | "weekly_monday"
  | "custom";

/**
 * 「何时执行」预设。定点时间按用户本机时区换算为 UTC cron，降低心智负担。
 */
export function patternFromWhenPreset(
  id: WhenPresetId,
  customPattern?: string,
): string {
  if (id === "custom") return (customPattern ?? "").trim();
  if (id === "every_15m") return "@every_15m";
  if (id === "every_30m") return "@every_30m";
  if (id === "every_1h") return "@hourly";
  if (id === "every_6h") return "@every_6h";
  if (id === "daily_morning") return localClockToCron(9, 0, "*");
  if (id === "daily_evening") return localClockToCron(21, 0, "*");
  if (id === "weekdays_morning") return localClockToCron(9, 0, "1-5");
  if (id === "weekly_monday") return localClockToCron(9, 0, "1");
  return "@every_1h";
}

/** 本机时区的时:分 → UTC 5 段 cron（分 时 日 月 周） */
export function localClockToCron(
  localHour: number,
  localMinute: number,
  dow: string,
): string {
  const d = new Date();
  d.setHours(localHour, localMinute, 0, 0);
  return `${d.getUTCMinutes()} ${d.getUTCHours()} * * ${dow}`;
}

export const WHEN_PRESETS: Array<{
  id: WhenPresetId;
  label: string;
  hint: string;
}> = [
  { id: "every_15m", label: "每 15 分钟", hint: "适合监控与跟进" },
  { id: "every_30m", label: "每 30 分钟", hint: "适中频率" },
  { id: "every_1h", label: "每小时", hint: "日常巡检" },
  { id: "every_6h", label: "每 6 小时", hint: "低频检查" },
  { id: "daily_morning", label: "每天上午 9 点", hint: "按你电脑时区" },
  { id: "daily_evening", label: "每天晚上 9 点", hint: "按你电脑时区" },
  { id: "weekdays_morning", label: "工作日上午 9 点", hint: "周一至周五" },
  { id: "weekly_monday", label: "每周一上午 9 点", hint: "周报类任务" },
  { id: "custom", label: "自定义", hint: "cron 或 @every" },
];

/** 从已存 pattern 尽量反推预设，便于编辑回填 */
export function whenPresetFromPattern(pattern: string): {
  preset: WhenPresetId;
  custom: string;
} {
  const p = pattern.trim();
  if (p === "@every_15m") return { preset: "every_15m", custom: "" };
  if (p === "@every_30m") return { preset: "every_30m", custom: "" };
  if (p === "@hourly" || p === "0 * * * *") return { preset: "every_1h", custom: "" };
  if (p === "@every_6h") return { preset: "every_6h", custom: "" };
  // 定点预设会因时区换算不同，编辑时落到自定义并展示原 pattern
  return { preset: "custom", custom: p };
}

/** pattern → 人话说明 */
export function describePattern(pattern: string): string {
  const p = pattern.trim();
  if (p === "@every_15m") return "每 15 分钟";
  if (p === "@every_30m") return "每 30 分钟";
  if (p === "@hourly" || p === "0 * * * *") return "每小时";
  if (p === "@every_6h") return "每 6 小时";
  if (p === "@daily" || p === "0 0 * * *") return "每天 00:00（UTC）";
  if (p === "@weekly" || p === "0 0 * * 0") return "每周日 00:00（UTC）";
  if (p === "@monthly" || p === "0 0 1 * *") return "每月 1 日 00:00（UTC）";

  const every = p.match(/^@every_(\d+)(m|h)$/i);
  if (every) {
    const n = every[1];
    return every[2]!.toLowerCase() === "m" ? `每 ${n} 分钟` : `每 ${n} 小时`;
  }

  const five = p.split(/\s+/);
  if (five.length === 5) {
    const [min, hour, , , dow] = five;
    if (min && hour && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
      const local = utcClockToLocalLabel(Number(hour), Number(min));
      const dayPart =
        dow === "*"
          ? "每天"
          : dow === "1-5"
            ? "工作日"
            : dow === "0" || dow === "7"
              ? "每周日"
              : dow === "1"
                ? "每周一"
                : `周 ${dow}`;
      return `${dayPart} ${local}`;
    }
  }
  return p;
}

function utcClockToLocalLabel(utcHour: number, utcMinute: number): string {
  const d = new Date();
  d.setUTCHours(utcHour, utcMinute, 0, 0);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 相对时间（简短中文） */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const past = diff < 0;
  let body: string;
  if (mins < 1) body = "不到 1 分钟";
  else if (mins < 60) body = `${mins} 分钟`;
  else if (hours < 48) body = `${hours} 小时`;
  else body = `${days} 天`;
  return past ? `${body}前` : `${body}后`;
}

export function formatAbsoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "ok":
    case "completed":
      return "成功";
    case "failed":
      return "失败";
    case "running":
    case "queued":
      return "进行中";
    case "skipped":
      return "已跳过";
    default:
      return status || "—";
  }
}

export function statusTone(
  status: string | null | undefined,
): "success" | "danger" | "warn" | "secondary" {
  switch (status) {
    case "ok":
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
    case "queued":
      return "warn";
    default:
      return "secondary";
  }
}

// ── API ────────────────────────────────────────────────────────

export async function listSchedules(agentId: string) {
  const res = await api<{ schedules: AgentSchedule[] }>(
    `/api/agents/${agentId}/schedules`,
  );
  return res.schedules;
}

export async function createSchedule(
  agentId: string,
  body: {
    name: string;
    description?: string;
    pattern: string;
    prompt: string;
    enabled?: boolean;
    maxRuns?: number | null;
  },
) {
  const res = await api<{ schedule: AgentSchedule }>(
    `/api/agents/${agentId}/schedules`,
    { method: "POST", json: body },
  );
  return res.schedule;
}

export async function updateSchedule(
  agentId: string,
  scheduleId: string,
  body: Partial<{
    name: string;
    description: string;
    pattern: string;
    prompt: string;
    enabled: boolean;
    maxRuns: number | null;
  }>,
) {
  const res = await api<{ schedule: AgentSchedule }>(
    `/api/agents/${agentId}/schedules/${scheduleId}`,
    { method: "PATCH", json: body },
  );
  return res.schedule;
}

export async function deleteSchedule(agentId: string, scheduleId: string) {
  await api(`/api/agents/${agentId}/schedules/${scheduleId}`, {
    method: "DELETE",
  });
}

export async function runScheduleNow(agentId: string, scheduleId: string) {
  const res = await api<{ run: AutomationRun }>(
    `/api/agents/${agentId}/schedules/${scheduleId}/run`,
    { method: "POST" },
  );
  return res.run;
}

export async function listAutomationRuns(
  agentId: string,
  opts?: { limit?: number; kind?: "schedule" | "heartbeat" },
) {
  const qs = new URLSearchParams();
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.kind) qs.set("kind", opts.kind);
  const res = await api<{ runs: AutomationRun[] }>(
    `/api/agents/${agentId}/automation/runs?${qs}`,
  );
  return res.runs;
}
