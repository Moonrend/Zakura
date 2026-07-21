import type { McpToolDef } from "@zakura/shared";
import { googleFetch } from "./client.js";

type ChatSpace = {
  name?: string;
  displayName?: string;
  spaceType?: string;
  spaceThreadingState?: string;
  lastActiveTime?: string;
  singleUserBotDm?: boolean;
};

type ChatMessage = {
  name?: string;
  text?: string;
  formattedText?: string;
  createTime?: string;
  thread?: { name?: string };
  sender?: {
    name?: string;
    displayName?: string;
    type?: string;
  };
  attachment?: Array<{
    name?: string;
    contentName?: string;
    contentType?: string;
    source?: string;
  }>;
  emojiReactionSummaries?: Array<{
    emoji?: { unicode?: string; customEmoji?: { unicode?: string } };
    reactionCount?: number;
  }>;
};

function mapConversationType(spaceType?: string): string {
  switch (spaceType) {
    case "DIRECT_MESSAGE":
      return "DIRECT_MESSAGE";
    case "GROUP_CHAT":
      return "GROUP_CHAT";
    case "SPACE":
      return "NAMED_SPACE";
    default:
      return spaceType || "CONVERSATION_TYPE_UNSPECIFIED";
  }
}

function mapMessage(m: ChatMessage) {
  return {
    messageId: m.name ?? "",
    threadId: m.thread?.name ?? "",
    plaintextBody: m.formattedText || m.text || "",
    sender: {
      userId: m.sender?.name ?? "",
      displayName: m.sender?.displayName ?? "",
      userType: m.sender?.type === "BOT" ? "APP" : "HUMAN",
    },
    createTime: m.createTime,
    threadedReply: !!m.thread?.name,
    attachments: (m.attachment ?? []).map((a) => ({
      attachmentId: a.name,
      filename: a.contentName,
      mimeType: a.contentType,
      source: a.source,
    })),
    reactionSummaries: (m.emojiReactionSummaries ?? []).map((r) => ({
      emoji: r.emoji?.unicode || r.emoji?.customEmoji?.unicode || "",
      count: r.reactionCount ?? 0,
    })),
  };
}

function toUserResourceName(participant: string): string {
  const p = participant.trim();
  if (p.startsWith("users/")) return p;
  return `users/${p}`;
}

async function findDirectMessage(token: string, participant: string): Promise<ChatSpace | null> {
  try {
    return await googleFetch<ChatSpace>(token, "https://chat.googleapis.com/v1/spaces:findDirectMessage", {
      method: "POST",
      json: { name: toUserResourceName(participant) },
    });
  } catch {
    return null;
  }
}

export const chatToolDefs: McpToolDef[] = [
  {
    name: "search_conversations",
    description:
      "Search Google Chat conversations by display name and/or participant emails (excluding caller).",
    inputSchema: {
      type: "object",
      properties: {
        spaceNameQuery: { type: "string" },
        participants: { type: "array", items: { type: "string" } },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "list_messages",
    description: "List messages in a conversation (space). Optional threadId / time range filter.",
    inputSchema: {
      type: "object",
      required: ["conversationId"],
      properties: {
        conversationId: { type: "string", description: "spaces/XXXX" },
        threadId: { type: "string", description: "spaces/XXXX/threads/YYYY" },
        startTime: { type: "string", description: "RFC3339 inclusive lower bound" },
        endTime: { type: "string", description: "RFC3339 exclusive upper bound" },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "search_messages",
    description:
      "Search messages within a conversation by text query (client-side filter on recent pages; Chat API has no full-text search).",
    inputSchema: {
      type: "object",
      required: ["conversationId", "query"],
      properties: {
        conversationId: { type: "string" },
        query: { type: "string" },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a Chat message (Markdown supported). conversationId required; optional threadId.",
    inputSchema: {
      type: "object",
      required: ["conversationId", "messageText"],
      properties: {
        conversationId: { type: "string" },
        threadId: { type: "string" },
        messageText: { type: "string" },
      },
    },
  },
];

export async function callChatTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_conversations": {
      const pageSize = Math.min(Number(args.pageSize) || 100, 1000);
      const query = typeof args.spaceNameQuery === "string" ? args.spaceNameQuery.trim() : "";
      const participants = Array.isArray(args.participants)
        ? args.participants.map(String).filter(Boolean)
        : [];

      // 单人：优先 findDirectMessage（支持 email 或 users/{id}）
      if (participants.length === 1 && !query) {
        const dm = await findDirectMessage(token, participants[0]!);
        if (dm?.name) {
          return {
            conversations: [
              {
                conversationId: dm.name,
                displayName: dm.displayName || dm.name,
                conversationType: mapConversationType(dm.spaceType),
                lastActiveTimestamp: dm.lastActiveTime,
              },
            ],
          };
        }
      }

      const params = new URLSearchParams({
        pageSize: String(pageSize),
        filter: 'spaceType = "SPACE" OR spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"',
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const res = await googleFetch<{ spaces?: ChatSpace[]; nextPageToken?: string }>(
        token,
        `https://chat.googleapis.com/v1/spaces?${params}`,
      );
      let conversations = (res.spaces ?? []).map((s) => ({
        conversationId: s.name ?? "",
        displayName: s.displayName || s.name || "",
        conversationType: mapConversationType(s.spaceType),
        lastActiveTimestamp: s.lastActiveTime,
      }));

      if (query) {
        const q = query.toLowerCase();
        conversations = conversations.filter((c) =>
          c.displayName.toLowerCase().includes(q),
        );
      }

      if (participants.length) {
        const wanted = new Set(participants.map((p) => p.trim().toLowerCase()));
        const filtered: typeof conversations = [];
        for (const c of conversations.slice(0, 40)) {
          if (!c.conversationId) continue;
          try {
            const members = await googleFetch<{
              memberships?: Array<{
                member?: { name?: string; displayName?: string; type?: string };
              }>;
            }>(
              token,
              `https://chat.googleapis.com/v1/${c.conversationId}/members?pageSize=100`,
            );
            const hay = (members.memberships ?? [])
              .map((m) => `${m.member?.name ?? ""} ${m.member?.displayName ?? ""}`.toLowerCase())
              .join("\n");
            const hit = [...wanted].some((p) => {
              const bare = p.replace(/^users\//, "");
              return hay.includes(p) || hay.includes(bare);
            });
            if (hit) filtered.push(c);
          } catch {
            /* skip inaccessible */
          }
        }
        conversations = filtered;
      }

      return {
        conversations,
        nextPageToken: res.nextPageToken,
      };
    }
    case "list_messages": {
      const conversationId = String(args.conversationId ?? "").trim();
      if (!conversationId) throw new Error("conversationId required");
      const pageSize = Math.min(Number(args.pageSize) || 25, 1000);
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const filters: string[] = [];
      const threadId = typeof args.threadId === "string" ? args.threadId.trim() : "";
      if (threadId) filters.push(`thread.name = "${threadId}"`);
      const startTime = typeof args.startTime === "string" ? args.startTime.trim() : "";
      const endTime = typeof args.endTime === "string" ? args.endTime.trim() : "";
      if (startTime) filters.push(`createTime > "${startTime}"`);
      if (endTime) filters.push(`createTime < "${endTime}"`);
      if (filters.length) params.set("filter", filters.join(" AND "));
      const res = await googleFetch<{ messages?: ChatMessage[]; nextPageToken?: string }>(
        token,
        `https://chat.googleapis.com/v1/${conversationId}/messages?${params}`,
      );
      return {
        messages: (res.messages ?? []).map(mapMessage),
        nextPageToken: res.nextPageToken,
      };
    }
    case "search_messages": {
      const conversationId = String(args.conversationId ?? "").trim();
      const query = String(args.query ?? "").trim();
      if (!conversationId || !query) throw new Error("conversationId and query required");
      const pageSize = Math.min(Number(args.pageSize) || 50, 200);
      const params = new URLSearchParams({
        pageSize: String(pageSize),
        orderBy: "createTime desc",
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const res = await googleFetch<{ messages?: ChatMessage[]; nextPageToken?: string }>(
        token,
        `https://chat.googleapis.com/v1/${conversationId}/messages?${params}`,
      );
      const q = query.toLowerCase();
      const messages = (res.messages ?? [])
        .filter((m) => (m.text || m.formattedText || "").toLowerCase().includes(q))
        .map(mapMessage);
      return { messages, nextPageToken: res.nextPageToken };
    }
    case "send_message": {
      const conversationId = String(args.conversationId ?? "").trim();
      const messageText = String(args.messageText ?? "");
      if (!conversationId || !messageText) {
        throw new Error("conversationId and messageText required");
      }
      const threadId = typeof args.threadId === "string" ? args.threadId.trim() : "";
      const body: Record<string, unknown> = { text: messageText };
      if (threadId) body.thread = { name: threadId };
      const messageReplyOption = threadId
        ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
        : undefined;
      const qs = messageReplyOption
        ? `?messageReplyOption=${messageReplyOption}`
        : "";
      const created = await googleFetch<ChatMessage>(
        token,
        `https://chat.googleapis.com/v1/${conversationId}/messages${qs}`,
        { method: "POST", json: body },
      );
      return { message: mapMessage(created) };
    }
    default:
      throw new Error(`Unknown chat tool: ${name}`);
  }
}
