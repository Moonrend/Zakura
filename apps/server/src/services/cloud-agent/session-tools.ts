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
          "列出本 Agent 最近的聊天会话（标题、时间、状态）。需要回顾或续接旧对话时先调用。",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              default: 15,
              description: "返回条数",
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
          "按关键词搜索本 Agent 的历史会话（标题 + 消息正文）。找到 session_id 后可用 get_chat_messages / import_session_context。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索词" },
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
          "读取某会话的对话摘录（用户/助手轮次，工具输出已压缩）。用于核对旧对话细节。",
        parameters: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 40,
              default: 20,
              description: "最多返回最近多少条模型消息",
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
          "导入另一会话的上下文摘要（不修改当前会话事件流）。把返回的 summary 当作背景继续工作；需要持久续聊请让用户使用「从会话派生」或你说明摘要要点。",
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
      if (!row) return { text: "会话不存在或不属于本 Agent", isError: true };

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
          ? `【已有压缩摘要】\n${existingSummary.slice(0, Math.floor(maxChars * 0.5))}`
          : "",
        olderCount > 0 ? `【更早对话摘录】\n${digest}` : "",
        recent.length
          ? `【最近 ${recent.length} 条】\n${recentText}`
          : messages.length
            ? `【全文摘录】\n${buildCompactionDigest(messages).slice(0, maxChars)}`
            : "（空会话）",
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
            note: "以上为导入上下文，不会自动写入当前会话。需要时请在回复中沿用关键事实。",
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
