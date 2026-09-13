/**
 * Agent 侧 Routine 工具：定时（cron）与事件（listener），主 chat 会话注入。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import { parseProjectField } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { AgentAutomationService } from "../agent-automation.js";
import { CronParseError, RoutineListenerError } from "../agent-automation.js";

export const LIST_AUTOMATION_RUNS_TOOL = "list_automation_runs";
export const LIST_ROUTINES_TOOL = "list_routines";
export const CREATE_ROUTINE_TOOL = "create_routine";
export const UPDATE_ROUTINE_TOOL = "update_routine";
export const DELETE_ROUTINE_TOOL = "delete_routine";
export const PAUSE_ROUTINE_TOOL = "pause_routine";
export const RUN_ROUTINE_TOOL = "run_routine_now";

const SET = new Set([
  LIST_AUTOMATION_RUNS_TOOL,
  LIST_ROUTINES_TOOL,
  CREATE_ROUTINE_TOOL,
  UPDATE_ROUTINE_TOOL,
  DELETE_ROUTINE_TOOL,
  PAUSE_ROUTINE_TOOL,
  RUN_ROUTINE_TOOL,
]);

export function isAutomationToolName(name: string): boolean {
  return SET.has(name);
}

const CRON_HELP = [
  "5-field cron (min hour dom month dow), e.g. `0 9 * * 1-5`;",
  "`CRON_TZ=Asia/Shanghai 0 9 * * 1-5`;",
  "`@hourly` / `@daily` / `@weekly` / `@monthly`;",
  "`@every 5m` / `@every_2h` (fastest ~5 minutes).",
].join(" ");

const LISTENER_HELP = [
  "listener is an object. source is one of webhook, slack, github, origin, teams, linear, sentry, pagerduty, group.",
  "Slack: {source, channel (#eng | @name | *), match: mention|keyword|any|reaction, keywords?, emojis?}.",
  "GitHub/Origin: {source, repo: owner/name, events: [pr_opened|pr_pushed|pr_merged|pr_closed|review_requested|approved|changes_requested|review_comment|pr_comment|inline_comment|thread_resolved|thread_reopened|issue_assigned|ci_passed|ci_failed], prNumber?, users?, branch?}. CI without a PR number must set branch. Watching a PR with merge/close usually auto-stops.",
  "Webhook: {source: webhook} — URL is returned; secret is only in the routine panel.",
  "Group: {source: group, listeners: [...]} OR any child. Origin must not mix with teams/linear/sentry/pagerduty/webhook.",
  "Prefer events over polling.",
].join(" ");

export function listAutomationToolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: LIST_ROUTINES_TOOL,
        description:
          "List this agent's routines (cron + event). Includes name, trigger, next run, webhook URL (not secret), status.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: CREATE_ROUTINE_TOOL,
        description: [
          "Create a routine: a saved intent + one trigger (cron XOR listener, never both).",
          "Write prompt as intent (e.g. summarize unread mail), not a frozen tool-call script.",
          "Cron:",
          CRON_HELP,
          "Listener:",
          LISTENER_HELP,
          "If the task writes files, pass project (workspace project slug).",
          "Default to weekday daytime cron unless the user asked for nights/weekends or the job is inherently 24/7.",
        ].join(" "),
        parameters: {
          type: "object",
          required: ["name", "prompt"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            prompt: {
              type: "string",
              description: "Intent to run on each trigger",
            },
            trigger: {
              type: "string",
              enum: ["cron", "listener"],
              description: "Default cron if pattern is set, listener if listener is set",
            },
            pattern: { type: "string", description: "Cron / @every / CRON_TZ=... " },
            timezone: { type: "string", description: "IANA timezone; default UTC" },
            listener: {
              type: "object",
              description: "Event trigger. See tool description for source schemas.",
            },
            project: {
              type: "string",
              description:
                "Workspace project slug. File-producing tasks must set this. Defaults to the current session's project.",
            },
            enabled: { type: "boolean", default: true },
            max_runs: {
              type: "integer",
              minimum: 1,
              description: "Max runs; omit for unlimited",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: UPDATE_ROUTINE_TOOL,
        description:
          "Update a routine (name / prompt / cron / listener / enabled). History is kept. Pause with enabled=false.",
        parameters: {
          type: "object",
          required: ["routine_id"],
          properties: {
            routine_id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            prompt: { type: "string" },
            trigger: { type: "string", enum: ["cron", "listener"] },
            pattern: { type: "string" },
            timezone: { type: "string" },
            listener: { type: "object" },
            project: {
              type: ["string", "null"],
              description: "Workspace project slug; null to unbind",
            },
            enabled: { type: "boolean" },
            max_runs: { type: ["integer", "null"] },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: PAUSE_ROUTINE_TOOL,
        description: "Pause or resume a routine.",
        parameters: {
          type: "object",
          required: ["routine_id", "enabled"],
          properties: {
            routine_id: { type: "string" },
            enabled: {
              type: "boolean",
              description: "true = resume, false = pause",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: DELETE_ROUTINE_TOOL,
        description: "Delete a routine.",
        parameters: {
          type: "object",
          required: ["routine_id"],
          properties: { routine_id: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: RUN_ROUTINE_TOOL,
        description: "Trigger a routine once immediately (does not change cadence).",
        parameters: {
          type: "object",
          required: ["routine_id"],
          properties: { routine_id: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: LIST_AUTOMATION_RUNS_TOOL,
        description: "List recent routine trigger records.",
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

function idOf(args: Record<string, unknown>): string {
  return String(args.routine_id ?? "").trim();
}

export async function callAutomationTool(
  automation: AgentAutomationService,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  extra?: { defaultProject?: string | null },
): Promise<{ text: string; isError?: boolean }> {
  try {
    if (name === LIST_ROUTINES_TOOL) {
      const items = await automation.listSchedules(agent.tenantId, agent.id);
      return { text: JSON.stringify({ routines: items }, null, 2) };
    }
    if (name === CREATE_ROUTINE_TOOL) {
      const parsed = parseProjectField(args.project);
      if (parsed.status === "invalid") {
        return { text: "invalid project slug", isError: true };
      }
      const trigger =
        args.trigger === "listener" || args.listener
          ? "listener"
          : args.trigger === "cron" || args.pattern
            ? "cron"
            : "cron";
      const created = await automation.createSchedule(agent.tenantId, agent.id, {
        name: String(args.name ?? ""),
        description: typeof args.description === "string" ? args.description : undefined,
        triggerKind: trigger,
        pattern: typeof args.pattern === "string" ? args.pattern : undefined,
        listener: args.listener,
        prompt: String(args.prompt ?? ""),
        project: parsed.status === "ok" ? parsed.slug : (extra?.defaultProject ?? null),
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        maxRuns: typeof args.max_runs === "number" ? args.max_runs : undefined,
        timezone: typeof args.timezone === "string" ? args.timezone : undefined,
      });
      return { text: JSON.stringify({ routine: created }, null, 2) };
    }
    if (name === UPDATE_ROUTINE_TOOL || name === PAUSE_ROUTINE_TOOL) {
      const id = idOf(args);
      if (!id) return { text: "routine_id is required", isError: true };
      const parsed = parseProjectField(args.project);
      if (parsed.status === "invalid") {
        return { text: "invalid project slug", isError: true };
      }
      const updated = await automation.updateSchedule(agent.tenantId, agent.id, id, {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.description !== undefined
          ? { description: String(args.description) }
          : {}),
        ...(args.pattern !== undefined ? { pattern: String(args.pattern) } : {}),
        ...(args.prompt !== undefined ? { prompt: String(args.prompt) } : {}),
        ...(args.trigger === "cron" || args.trigger === "listener"
          ? { triggerKind: args.trigger }
          : {}),
        ...(args.listener !== undefined ? { listener: args.listener } : {}),
        ...(parsed.status === "ok" ? { project: parsed.slug } : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
        ...(args.max_runs === null
          ? { maxRuns: null }
          : typeof args.max_runs === "number"
            ? { maxRuns: args.max_runs }
            : {}),
        ...(typeof args.timezone === "string" ? { timezone: args.timezone } : {}),
      });
      if (!updated) return { text: "routine not found", isError: true };
      return { text: JSON.stringify({ routine: updated }, null, 2) };
    }
    if (name === DELETE_ROUTINE_TOOL) {
      const id = idOf(args);
      if (!id) return { text: "routine_id is required", isError: true };
      const ok = await automation.deleteSchedule(agent.tenantId, agent.id, id);
      if (!ok) return { text: "routine not found", isError: true };
      return { text: JSON.stringify({ ok: true, routine_id: id }, null, 2) };
    }
    if (name === RUN_ROUTINE_TOOL) {
      const id = idOf(args);
      if (!id) return { text: "routine_id is required", isError: true };
      const run = await automation.runScheduleNow(agent.tenantId, agent.id, id);
      return { text: JSON.stringify({ run }, null, 2) };
    }
    if (name === LIST_AUTOMATION_RUNS_TOOL) {
      const runs = await automation.listRuns(agent.tenantId, agent.id, {
        limit: typeof args.limit === "number" ? args.limit : 20,
      });
      return { text: JSON.stringify({ runs }, null, 2) };
    }
    return { text: `Unknown automation tool: ${name}`, isError: true };
  } catch (err) {
    const msg =
      err instanceof CronParseError || err instanceof RoutineListenerError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { text: msg, isError: true };
  }
}
