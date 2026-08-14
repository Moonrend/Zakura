/**
 * Zakura 主循环调用第三方 ACP Agent：列出已启用 profile，或开独立会话。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import {
  listEnabledAcpSetups,
  publicProfileForSetup,
} from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import { readAgentAcpConfig } from "../acp/config.js";
import type { AcpSessionService } from "../acp/session.js";

export const LIST_ACP_AGENTS_TOOL = "list_acp_agents";
export const SPAWN_ACP_AGENT_TOOL = "spawn_acp_agent";

const ACP_TOOL_SET = new Set([LIST_ACP_AGENTS_TOOL, SPAWN_ACP_AGENT_TOOL]);

export function isAcpToolName(name: string): boolean {
  return ACP_TOOL_SET.has(name);
}

export function listAcpToolDefinitions(agent: Agent): ModelToolDefinition[] {
  const enabled = listEnabledAcpSetups(readAgentAcpConfig(agent));
  if (enabled.length === 0) return [];
  const catalog = enabled
    .map((s) => {
      const p = publicProfileForSetup(s);
      return `${p.id}（${p.displayName}）`;
    })
    .join("、");
  return [
    {
      type: "function",
      function: {
        name: LIST_ACP_AGENTS_TOOL,
        description: `List third-party ACP coding agents enabled for this Zakura agent: ${catalog}.`,
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: SPAWN_ACP_AGENT_TOOL,
        description:
          "Start a separate conversation with an enabled ACP agent (Claude Code / Codex / Gemini / Hermes / OpenCode / custom). The user can open that session and continue. Use when the task is a better fit for that coding agent.",
        parameters: {
          type: "object",
          properties: {
            profile_id: {
              type: "string",
              description: `ACP profile id: ${enabled.map((s) => s.id).join(", ")}`,
            },
            task: {
              type: "string",
              description: "Self-contained task for the ACP agent",
            },
            project: {
              type: "string",
              description: "Optional workspace project slug",
            },
          },
          required: ["profile_id", "task"],
        },
      },
    },
  ];
}

export async function callAcpTool(
  acp: AcpSessionService,
  agent: Agent,
  tenantId: string,
  name: string,
  args: Record<string, unknown>,
  origin?: { parentSessionId?: string; parentRunId?: string; parentToolCallId?: string },
): Promise<{ text: string; link?: { sessionId: string; agentId: string } }> {
  if (name === LIST_ACP_AGENTS_TOOL) {
    const items = listEnabledAcpSetups(readAgentAcpConfig(agent)).map((s) => {
      const p = publicProfileForSetup(s);
      return {
        profile_id: p.id,
        display_name: p.displayName,
        description: p.description,
        setup_mode: s.setupMode,
        command: p.command,
        ...(p.sessionModeId ? { session_mode: p.sessionModeId } : {}),
      };
    });
    return { text: JSON.stringify({ agents: items, count: items.length }, null, 2) };
  }
  if (name === SPAWN_ACP_AGENT_TOOL) {
    const profileId = typeof args.profile_id === "string" ? args.profile_id.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!profileId || !task) throw new Error("profile_id 与 task 必填");
    const result = await acp.spawn({
      tenantId,
      agent,
      profileId,
      task,
      project: typeof args.project === "string" ? args.project : null,
      origin,
    });
    return {
      text: result.text
        ? `已在独立会话中启动 ${profileId}。\n\n${result.text}`
        : `已在独立会话中启动 ${profileId}。`,
      link: { sessionId: result.sessionId, agentId: agent.id },
    };
  }
  throw new Error(`unknown ACP tool ${name}`);
}
