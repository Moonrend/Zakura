/**
 * Agent 侧自动化工具：管理定时任务（主 chat 会话注入）。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { AgentAutomationService } from "../agent-automation.js";
import { CronParseError } from "../cron-next.js";

export const LIST_SCHEDULES_TOOL = "list_schedules";
export const CREATE_SCHEDULE_TOOL = "create_schedule";
export const UPDATE_SCHEDULE_TOOL = "update_schedule";
export const DELETE_SCHEDULE_TOOL = "delete_schedule";
export const RUN_SCHEDULE_TOOL = "run_schedule_now";
export const LIST_AUTOMATION_RUNS_TOOL = "list_automation_runs";

const SET = new Set([
  LIST_SCHEDULES_TOOL,
  CREATE_SCHEDULE_TOOL,
  UPDATE_SCHEDULE_TOOL,
  DELETE_SCHEDULE_TOOL,
  RUN_SCHEDULE_TOOL,
  LIST_AUTOMATION_RUNS_TOOL,
]);

export function isAutomationToolName(name: string): boolean {
  return SET.has(name);
}

export function listAutomationToolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: LIST_SCHEDULES_TOOL,
        description: "列出本 Agent 的定时任务（名称、cron/周期、下次执行、状态）。",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: CREATE_SCHEDULE_TOOL,
        description: [
          "创建定时任务。pattern 支持：",
          "5 段 cron（分 时 日 月 周，UTC），如 `0 9 * * 1-5`；",
          "`@hourly` / `@daily` / `@weekly`；",
          "`@every_30m` / `@every_2h`。",
          "prompt 为每次触发时注入的任务指令。",
        ].join(" "),
        parameters: {
          type: "object",
          required: ["name", "pattern", "prompt"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            pattern: { type: "string" },
            prompt: { type: "string" },
            enabled: { type: "boolean", default: true },
            max_runs: {
              type: "integer",
              minimum: 1,
              description: "最多执行次数；省略则不限",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: UPDATE_SCHEDULE_TOOL,
        description: "更新定时任务字段（name/pattern/prompt/enabled/max_runs 等）。",
        parameters: {
          type: "object",
          required: ["schedule_id"],
          properties: {
            schedule_id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            pattern: { type: "string" },
            prompt: { type: "string" },
            enabled: { type: "boolean" },
            max_runs: { type: ["integer", "null"] },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: DELETE_SCHEDULE_TOOL,
        description: "删除定时任务。",
        parameters: {
          type: "object",
          required: ["schedule_id"],
          properties: { schedule_id: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: RUN_SCHEDULE_TOOL,
        description: "立即触发一次定时任务（额外执行，不影响原定周期）。",
        parameters: {
          type: "object",
          required: ["schedule_id"],
          properties: { schedule_id: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: LIST_AUTOMATION_RUNS_TOOL,
        description: "列出最近的定时任务触发记录。",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
  ];
}

export async function callAutomationTool(
  automation: AgentAutomationService,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  try {
    if (name === LIST_SCHEDULES_TOOL) {
      const items = await automation.listSchedules(agent.tenantId, agent.id);
      return { text: JSON.stringify({ schedules: items }, null, 2) };
    }
    if (name === CREATE_SCHEDULE_TOOL) {
      const created = await automation.createSchedule(agent.tenantId, agent.id, {
        name: String(args.name ?? ""),
        description: typeof args.description === "string" ? args.description : undefined,
        pattern: String(args.pattern ?? ""),
        prompt: String(args.prompt ?? ""),
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        maxRuns: typeof args.max_runs === "number" ? args.max_runs : undefined,
      });
      return { text: JSON.stringify({ schedule: created }, null, 2) };
    }
    if (name === UPDATE_SCHEDULE_TOOL) {
      const id = String(args.schedule_id ?? "").trim();
      if (!id) return { text: "schedule_id is required", isError: true };
      const updated = await automation.updateSchedule(agent.tenantId, agent.id, id, {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.description !== undefined
          ? { description: String(args.description) }
          : {}),
        ...(args.pattern !== undefined ? { pattern: String(args.pattern) } : {}),
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
        ...(args.max_runs === null
          ? { maxRuns: null }
          : typeof args.max_runs === "number"
            ? { maxRuns: args.max_runs }
            : {}),
      });
      if (!updated) return { text: "schedule not found", isError: true };
      return { text: JSON.stringify({ schedule: updated }, null, 2) };
    }
    if (name === DELETE_SCHEDULE_TOOL) {
      const id = String(args.schedule_id ?? "").trim();
      if (!id) return { text: "schedule_id is required", isError: true };
      const ok = await automation.deleteSchedule(agent.tenantId, agent.id, id);
      if (!ok) return { text: "schedule not found", isError: true };
      return { text: JSON.stringify({ ok: true, schedule_id: id }, null, 2) };
    }
    if (name === RUN_SCHEDULE_TOOL) {
      const id = String(args.schedule_id ?? "").trim();
      if (!id) return { text: "schedule_id is required", isError: true };
      const run = await automation.runScheduleNow(agent.tenantId, agent.id, id);
      return { text: JSON.stringify({ run }, null, 2) };
    }
    if (name === LIST_AUTOMATION_RUNS_TOOL) {
      const runs = await automation.listRuns(agent.tenantId, agent.id, {
        kind: "schedule",
        limit: typeof args.limit === "number" ? args.limit : 20,
      });
      return { text: JSON.stringify({ runs }, null, 2) };
    }
    return { text: `Unknown automation tool: ${name}`, isError: true };
  } catch (err) {
    const msg =
      err instanceof CronParseError
        ? `invalid pattern: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { text: msg, isError: true };
  }
}
