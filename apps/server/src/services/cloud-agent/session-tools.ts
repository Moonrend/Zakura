/**
 * 对话复用工具：列会话 / 搜索 / 读历史 / 导入上下文。
 * 挂在主循环 tool 面（与 delegate 类似），不走 MCP 原生 agent 工具表。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import {
  buildChainMessages,
  buildCompactionDigest,
  buildSessionReuseDigest,
  eventsToMessages,
  messageTextForSummary,
} from "./messages.js";

export const LIST_SESSIONS_TOOL = "list_chat_sessions";
export const SEARCH_SESSIONS_TOOL = "search_chat_sessions";
export const GET_MESSAGES_TOOL = "get_chat_messages";
export const IMPORT_SESSION_TOOL = "import_session_context";

const SESSION_TOOL_SET = new Set([
  LIST_SESSIONS_TOOL,
  SEARCH_SESSIONS_TOOL,
  GET_MESSAGES_TOOL,
  IMPORT_SESSION_TOOL,
]);

export function isSessionToolName(name: string): boolean {
  return SESSION_TOOL_SET.has(name);
}

export function listSessionToolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: LIST_SESSIONS_TOOL,
        description:
          "List this agent's recent chat sessions (title, time, status). Call first when reviewing or continuing a past conversation.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              default: 15,
              description: "Max sessions to return",
            },
            include_archived: {
              type: "boolean",
              default: false,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: SEARCH_SESSIONS_TOOL,
        description:
          "Search this agent's past sessions by keyword (title + message body). After you have a session_id, use get_chat_messages / import_session_context.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 30,
              default: 10,
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: GET_MESSAGES_TOOL,
        description:
          "Read a transcript excerpt from a session (user/assistant turns; tool outputs are compressed). Use to verify details from an older chat.",
        parameters: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 40,
              default: 20,
              description: "Max recent model messages to return",
            },
          },
          required: ["session_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: IMPORT_SESSION_TOOL,
        description:
          "Import a context summary from another session (does not mutate the current session event stream). Treat the returned summary as background; for a durable fork ask the user to use \"fork from session\" or restate the key points yourself.",
        parameters: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            max_chars: {
              type: "integer",
              minimum: 2000,
              maximum: 24_000,
              default: 12_000,
            },
          },
          required: ["session_id"],
        },
      },
    },
  ];
}

function sessionBrief(row: {
  id: string;
  title: string;
  status: string;
  kind: string;
  updatedAt: Date;
  lastSeq: number;
}) {
  return {
    session_id: row.id,
    title: row.title,
    status: row.status,
    kind: row.kind,
    last_seq: row.lastSeq,
    updated_at: row.updatedAt.toISOString(),
  };
}

/** 从事件流尽量还原「到最后一条用户消息」的分支链；无用户消息则线性 eventsToMessages */
async function loadSessionMessages(
  store: CloudAgentSessionStore,
  sessionId: string,
): Promise<{ messages: ReturnType<typeof eventsToMessages>; turns: number }> {
  const lastCompaction = await store.getLastCompaction(sessionId);
  const events = await store.listEventsForChain(sessionId, {
    afterSeq: lastCompaction?.seq ?? 0,
  });
  const stored = events.map((e) => ({
    type: e.type,
    runId: e.runId,
    payload: e.payload as unknown as Record<string, unknown>,
  }));
  const lastUser = [...events].reverse().find((e) => e.type === "user_message");
  const mid = lastUser
    ? (lastUser.payload as Record<string, unknown>).messageId
    : null;
  if (typeof mid === "string") {
    try {
      const chain = buildChainMessages(stored, mid);
      return { messages: chain.messages, turns: chain.turns };
    } catch {
      /* fall through */
    }
  }
  return { messages: eventsToMessages(stored), turns: 0 };
}

export async function callSessionTool(
  store: CloudAgentSessionStore,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  currentSessionId: string,
): Promise<{ text: string; isError?: boolean }> {
  try {
    if (name === LIST_SESSIONS_TOOL) {
      const limit =
        typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 50) : 15;
      const rows = await store.listSessions(agent.tenantId, agent.id, {
        limit,
        includeArchived: Boolean(args.include_archived),
        kinds: ["chat"],
      });
      return {
        text: JSON.stringify(
          {
            current_session_id: currentSessionId,
            sessions: rows.map(sessionBrief),
          },
          null,
          2,
        ),
      };
    }

    if (name === SEARCH_SESSIONS_TOOL) {
      const query = String(args.query ?? "").trim();
      if (!query) return { text: "query is required", isError: true };
      const limit =
        typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 30) : 10;
      const hits = await store.searchSessions(agent.tenantId, query, {
        agentId: agent.id,
        limit,
        kinds: ["chat"],
      });
      return {
        text: JSON.stringify(
          {
            query,
            results: hits.map((h) => ({
              ...sessionBrief(h.session),
              snippet: h.snippet,
            })),
          },
          null,
          2,
        ),
      };
    }

    if (name === GET_MESSAGES_TOOL || name === IMPORT_SESSION_TOOL) {
      const sessionId = String(args.session_id ?? "").trim();
      if (!sessionId) return { text: "session_id is required", isError: true };
      const row = await store.getSession(agent.tenantId, agent.id, sessionId);
      if (!row) return { text: "Session not found or not owned by this agent", isError: true };

      const { messages, turns } = await loadSessionMessages(store, sessionId);

      if (name === GET_MESSAGES_TOOL) {
        const limit =
          typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 40) : 20;
        const slice = messages.slice(-limit);
        const lines = slice.map((m, i) => {
          const body = messageTextForSummary(m, 500);
          return `${i + 1}. [${m.role}${m.name ? `:${m.name}` : ""}] ${body}`;
        });
        return {
          text: JSON.stringify(
            {
              session_id: sessionId,
              title: row.title,
              turns,
              message_count: messages.length,
              returned: slice.length,
              messages: lines,
            },
            null,
            2,
          ),
        };
      }

      // import_session_context
      const maxChars =
        typeof args.max_chars === "number"
          ? Math.min(Math.max(args.max_chars, 2000), 24_000)
          : 12_000;
      const lastCompact = await store.getLastCompaction(sessionId);
      const existingSummary =
        typeof (lastCompact?.payload as Record<string, unknown> | undefined)?.summary ===
        "string"
          ? String((lastCompact!.payload as Record<string, unknown>).summary)
          : "";
      const { digest, recent, olderCount } = buildSessionReuseDigest(messages, {
        maxChars,
        keepRecent: 8,
      });
      const recentText = recent
        .map((m) => `${m.role}: ${messageTextForSummary(m, 400)}`)
        .join("\n");
      const summary = [
        existingSummary
          ? `[Existing compaction summary]\n${existingSummary.slice(0, Math.floor(maxChars * 0.5))}`
          : "",
        olderCount > 0 ? `[Older conversation digest]\n${digest}` : "",
        recent.length
          ? `[Recent ${recent.length} messages]\n${recentText}`
          : messages.length
            ? `[Full digest]\n${buildCompactionDigest(messages).slice(0, maxChars)}`
            : "(empty session)",
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, maxChars);

      return {
        text: JSON.stringify(
          {
            session_id: sessionId,
            title: row.title,
            turns,
            message_count: messages.length,
            summary,
            note: "Imported context only; it is not written into the current session. Reuse key facts in your reply when needed.",
          },
          null,
          2,
        ),
      };
    }

    return { text: `Unknown session tool: ${name}`, isError: true };
  } catch (err) {
    return {
      text: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}
