import type { ModelToolDefinition } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { MemoryStore } from "../memory-store.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";

/**
 * 跨 Agent 只读工具（同 Space 硬校验）：
 * - search_peer_memory(agentSlug, query)
 * - list_peer_sessions(agentSlug, limit)
 * - get_peer_messages(agentSlug, session_id)
 * 记忆/会话作用域仍 per-agent，这里只开只读通道；跨 Space / 跨租户一律拒绝。
 */

export const SEARCH_PEER_MEMORY_TOOL = "search_peer_memory";
export const LIST_PEER_SESSIONS_TOOL = "list_peer_sessions";
export const GET_PEER_MESSAGES_TOOL = "get_peer_messages";

const PEER_TOOL_SET = new Set([SEARCH_PEER_MEMORY_TOOL, LIST_PEER_SESSIONS_TOOL, GET_PEER_MESSAGES_TOOL]);

export function isPeerToolName(name: string): boolean {
  return PEER_TOOL_SET.has(name);
}

export function listPeerToolDefinitions(peerAgents: Agent[]): ModelToolDefinition[] {
  const slugs = peerAgents.slice(0, 20).map((a) => a.slug).join(", ");
  const slugProp = {
    type: "object" as const,
    properties: {
      agentSlug: {
        type: "string" as const,
        description: `Peer agent slug (same Space). Options: ${slugs}`,
      },
    },
    required: ["agentSlug" as const],
  };
  return [
    {
      type: "function",
      function: {
        name: SEARCH_PEER_MEMORY_TOOL,
        description: "Search another agent's long-term memory (read-only, same Space only).",
        parameters: {
          type: "object",
          properties: {
            ...slugProp.properties,
            query: { type: "string", description: "Search keywords" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["agentSlug", "query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: LIST_PEER_SESSIONS_TOOL,
        description: "List another agent's chat sessions (read-only, same Space only).",
        parameters: {
          type: "object",
          properties: {
            ...slugProp.properties,
            limit: { type: "number", description: "Max sessions (default 20)" },
          },
          required: ["agentSlug"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: GET_PEER_MESSAGES_TOOL,
        description: "Read messages of another agent's chat session (read-only, same Space only).",
        parameters: {
          type: "object",
          properties: {
            ...slugProp.properties,
            session_id: { type: "string", description: "Session id from list_peer_sessions" },
          },
          required: ["agentSlug", "session_id"],
        },
      },
    },
  ];
}

export type PeerToolDeps = {
  agentService: import("../agents.js").AgentService;
  memoryStore: MemoryStore | null | undefined;
  sessionStore: CloudAgentSessionStore;
};

async function resolvePeer(
  deps: PeerToolDeps,
  caller: Agent,
  rawSlug: string,
): Promise<Agent> {
  const slug = String(rawSlug ?? "").trim();
  if (!slug) throw new Error("agentSlug is required");
  const peer = await deps.agentService.get(caller.tenantId, slug);
  if (!peer) throw new Error(`未找到 Agent: ${slug}`);
  // 同 Space 硬校验：跨 Space / 跨租户一律拒绝
  if (peer.tenantId !== caller.tenantId || peer.spaceId !== caller.spaceId) {
    throw new Error(`${slug} 不在你的 Space，禁止跨 Space 读取`);
  }
  return peer;
}

export async function callPeerTool(
  deps: PeerToolDeps,
  caller: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  try {
    const peer = await resolvePeer(deps, caller, String(args.agentSlug ?? ""));
    if (name === SEARCH_PEER_MEMORY_TOOL) {
      if (!deps.memoryStore) return { text: "记忆服务不可用", isError: true };
      const query = String(args.query ?? "").trim();
      if (!query) return { text: "query is required", isError: true };
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const hits = await deps.memoryStore.search(peer.tenantId, peer.id, query, limit);
      return { text: JSON.stringify(hits, null, 2) };
    }
    if (name === LIST_PEER_SESSIONS_TOOL) {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const rows = await deps.sessionStore.listSessions(peer.tenantId, peer.id, { limit });
      return {
        text: JSON.stringify(
          rows.map((s) => ({ id: s.id, title: s.title ?? null, kind: s.kind, updatedAt: s.updatedAt })),
          null,
          2,
        ),
      };
    }
    if (name === GET_PEER_MESSAGES_TOOL) {
      const sessionId = String(args.session_id ?? "").trim();
      if (!sessionId) return { text: "session_id is required", isError: true };
      const row = await deps.sessionStore.getSession(peer.tenantId, peer.id, sessionId);
      if (!row) return { text: "Session not found or not owned by the peer", isError: true };
      const events = await deps.sessionStore.listEvents(sessionId);
      return { text: JSON.stringify(events, null, 2) };
    }
    return { text: `Unknown peer tool: ${name}`, isError: true };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}
