/**
 * 远程通道工具面：对齐 Chat SDK `createChatTools({ preset: "messenger" })`，
 * 让 Agent 自主决定何时发帖/回帖/反应，而不是由 egress 镜像 assistant_message。
 *
 * 不引入 `ai` 包；直接调用 Chat.thread / channel / openDM。
 */
import { textResult } from "@zakura/core";
import type { McpToolResult } from "@zakura/shared";
import type { ModelToolDefinition } from "@zakura/shared";

export const CHAT_POST_MESSAGE = "chat_post_message";
export const CHAT_POST_CHANNEL_MESSAGE = "chat_post_channel_message";
export const CHAT_SEND_DIRECT_MESSAGE = "chat_send_direct_message";
export const CHAT_ADD_REACTION = "chat_add_reaction";
export const CHAT_START_TYPING = "chat_start_typing";
export const CHAT_FETCH_MESSAGES = "chat_fetch_messages";
export const CHAT_FETCH_THREAD = "chat_fetch_thread";
export const CHAT_GET_CHANNEL_INFO = "chat_get_channel_info";
export const CHAT_GET_USER = "chat_get_user";

export const REMOTE_CHANNEL_TOOL_NAMES = [
  CHAT_POST_MESSAGE,
  CHAT_POST_CHANNEL_MESSAGE,
  CHAT_SEND_DIRECT_MESSAGE,
  CHAT_ADD_REACTION,
  CHAT_START_TYPING,
  CHAT_FETCH_MESSAGES,
  CHAT_FETCH_THREAD,
  CHAT_GET_CHANNEL_INFO,
  CHAT_GET_USER,
] as const;

export type RemoteChannelToolName = (typeof REMOTE_CHANNEL_TOOL_NAMES)[number];

export function isRemoteChannelToolName(name: string): name is RemoteChannelToolName {
  return (REMOTE_CHANNEL_TOOL_NAMES as readonly string[]).includes(name);
}

/** Chat SDK Chat 实例上我们实际用到的方法 */
export type RemoteChatHandle = {
  thread(threadId: string): {
    id: string;
    channelId: string;
    isDM: boolean;
    post(message: unknown): Promise<{ id: string; threadId: string }>;
    startTyping(status?: string): Promise<void>;
    adapter: {
      addReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
      fetchMessages?(
        threadId: string,
        options?: { limit?: number; cursor?: string; direction?: string },
      ): Promise<{ messages: any[]; nextCursor?: string }>;
    };
    getParticipants?(): Promise<Array<{ userId?: string; userName?: string; fullName?: string }>>;
  };
  channel(channelId: string): {
    id: string;
    name?: string;
    isDM?: boolean;
    post(message: unknown): Promise<{ id: string; threadId: string }>;
    info?(): Promise<{ name?: string; memberCount?: number; channelVisibility?: string } | null>;
  };
  openDM(userId: string): Promise<{
    id: string;
    post(message: unknown): Promise<{ id: string; threadId: string }>;
  }>;
  getUser?(userId: string): Promise<{
    userId: string;
    userName: string;
    fullName: string;
    email?: string;
    isBot?: boolean;
    avatarUrl?: string;
  } | null>;
};

export type RemoteChannelSessionHandle = {
  chat: RemoteChatHandle;
  /** 入站线程完整 id，例如 slack:C123:1234567890.123456 */
  threadId: string;
  channelId: string;
  platform: string;
  bindingId: string;
};

export type RemoteChannelToolPort = {
  get(sessionId: string): RemoteChannelSessionHandle | undefined;
  bind(sessionId: string, handle: RemoteChannelSessionHandle): void;
  unbind(sessionId: string): void;
};

export class RemoteChannelSessionRegistry implements RemoteChannelToolPort {
  private readonly sessions = new Map<string, RemoteChannelSessionHandle>();

  bind(sessionId: string, handle: RemoteChannelSessionHandle): void {
    this.sessions.set(sessionId, handle);
  }

  unbind(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get(sessionId: string): RemoteChannelSessionHandle | undefined {
    return this.sessions.get(sessionId);
  }
}

const MESSAGE_SCHEMA = {
  type: "string",
  description: "Message text; Markdown supported",
} as const;

export function listRemoteChannelToolDefinitions(
  handle: RemoteChannelSessionHandle,
): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: CHAT_POST_MESSAGE,
        description: [
          `Post an extra message in the current remote session (default thread ${handle.threadId}).`,
          "The final assistant reply is streamed to the current thread automatically — do not repost that same text with this tool.",
          "Use for: progress during tool runs, intermediate conclusions, follow-ups, or posting to another threadId.",
          "message should be natural language / Markdown.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            message: MESSAGE_SCHEMA,
            threadId: {
              type: "string",
              description: `Full thread id (e.g. slack:C123:ts); default ${handle.threadId}`,
            },
          },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_POST_CHANNEL_MESSAGE,
        description:
          "Post a top-level channel message (not under an existing thread). channelId must include the platform prefix.",
        parameters: {
          type: "object",
          properties: {
            message: MESSAGE_SCHEMA,
            channelId: {
              type: "string",
              description: `Full channel id; default ${handle.channelId}`,
            },
          },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_SEND_DIRECT_MESSAGE,
        description: "Open (or reuse) a DM with a user and send a message.",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Platform user id" },
            message: MESSAGE_SCHEMA,
          },
          required: ["userId", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_ADD_REACTION,
        description: "Add an emoji reaction to a message.",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "Platform message id" },
            emoji: {
              type: "string",
              description: "Emoji name, e.g. thumbs_up / white_check_mark",
            },
            threadId: {
              type: "string",
              description: `Full thread id; default ${handle.threadId}`,
            },
          },
          required: ["messageId", "emoji"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_START_TYPING,
        description: "Show a typing indicator in a thread.",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `Full thread id; default ${handle.threadId}`,
            },
            status: { type: "string", description: "Optional status text" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_FETCH_MESSAGES,
        description: "Fetch recent messages from a thread.",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `Full thread id; default ${handle.threadId}`,
            },
            limit: { type: "integer", description: "Count; default 20" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_FETCH_THREAD,
        description: "Get thread metadata (channel, DM flag, etc.).",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `Full thread id; default ${handle.threadId}`,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_GET_CHANNEL_INFO,
        description: "Get channel metadata.",
        parameters: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: `Full channel id; default ${handle.channelId}`,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_GET_USER,
        description: "Look up a user profile by id.",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Platform user id" },
          },
          required: ["userId"],
        },
      },
    },
  ];
}

function toPostable(message: unknown): string | { markdown: string } | { raw: string } {
  if (typeof message === "string") return { markdown: message };
  if (message && typeof message === "object") {
    const o = message as Record<string, unknown>;
    if (typeof o.markdown === "string") return { markdown: o.markdown };
    if (typeof o.raw === "string") return { raw: o.raw };
    if (typeof o.text === "string") return { markdown: o.text };
  }
  return { markdown: String(message ?? "") };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function projectMessage(message: any) {
  return {
    id: String(message?.id ?? ""),
    threadId: String(message?.threadId ?? ""),
    text: String(message?.text ?? ""),
    author: {
      userId: String(message?.author?.userId ?? ""),
      userName: String(message?.author?.userName ?? ""),
      fullName: String(message?.author?.fullName ?? ""),
      isBot: message?.author?.isBot ?? "unknown",
    },
    dateSent: message?.dateSent ? String(message.dateSent) : undefined,
  };
}

export async function callRemoteChannelTool(
  handle: RemoteChannelSessionHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    const result = await dispatch(handle, name, args);
    return textResult(JSON.stringify(result), false);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

async function dispatch(
  handle: RemoteChannelSessionHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { chat } = handle;
  switch (name) {
    case CHAT_POST_MESSAGE: {
      const message = args.message;
      if (message == null || message === "") throw new Error("message is required");
      const threadId = str(args, "threadId") ?? handle.threadId;
      const sent = await chat.thread(threadId).post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_POST_CHANNEL_MESSAGE: {
      const message = args.message;
      if (message == null || message === "") throw new Error("message is required");
      const channelId = str(args, "channelId") ?? handle.channelId;
      const sent = await chat.channel(channelId).post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_SEND_DIRECT_MESSAGE: {
      const userId = str(args, "userId");
      const message = args.message;
      if (!userId) throw new Error("userId is required");
      if (message == null || message === "") throw new Error("message is required");
      const dm = await chat.openDM(userId);
      const sent = await dm.post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_ADD_REACTION: {
      const messageId = str(args, "messageId");
      const emoji = str(args, "emoji");
      if (!messageId || !emoji) throw new Error("messageId and emoji are required");
      const threadId = str(args, "threadId") ?? handle.threadId;
      await chat.thread(threadId).adapter.addReaction(threadId, messageId, emoji);
      return { added: true, emoji, messageId, threadId };
    }
    case CHAT_START_TYPING: {
      const threadId = str(args, "threadId") ?? handle.threadId;
      const status = str(args, "status");
      await chat.thread(threadId).startTyping(status);
      return { typing: true, threadId };
    }
    case CHAT_FETCH_MESSAGES: {
      const threadId = str(args, "threadId") ?? handle.threadId;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 100)
          : 20;
      const thread = chat.thread(threadId);
      if (typeof thread.adapter.fetchMessages === "function") {
        const fetched = await thread.adapter.fetchMessages(threadId, {
          limit,
          direction: "backward",
        });
        return {
          messages: (fetched.messages ?? []).map(projectMessage),
          nextCursor: fetched.nextCursor,
        };
      }
      return { messages: [], nextCursor: undefined };
    }
    case CHAT_FETCH_THREAD: {
      const threadId = str(args, "threadId") ?? handle.threadId;
      const thread = chat.thread(threadId);
      return {
        id: thread.id,
        channelId: thread.channelId,
        isDM: thread.isDM,
      };
    }
    case CHAT_GET_CHANNEL_INFO: {
      const channelId = str(args, "channelId") ?? handle.channelId;
      const channel = chat.channel(channelId);
      const info = typeof channel.info === "function" ? await channel.info() : null;
      return {
        id: channel.id,
        name: info?.name ?? channel.name,
        isDM: channel.isDM,
        memberCount: info?.memberCount,
        channelVisibility: info?.channelVisibility,
      };
    }
    case CHAT_GET_USER: {
      const userId = str(args, "userId");
      if (!userId) throw new Error("userId is required");
      if (typeof chat.getUser !== "function") {
        throw new Error("This Chat instance does not support getUser");
      }
      return (await chat.getUser(userId)) ?? null;
    }
    default:
      throw new Error(`Unknown remote channel tool: ${name}`);
  }
}

export function remoteChannelPromptBlock(handle: RemoteChannelSessionHandle): string {
  return [
    "# Remote messaging channel (required)",
    `You are chatting in a ${handle.platform} remote session (thread ${handle.threadId}, channel ${handle.channelId}).`,
    "",
    "## How to reply",
    "- When a user message arrives the platform auto-reacts with 👀; your final text reply is streamed as a real message into the current thread (content already posted during tool runs is kept).",
    "- Therefore: write the normal final answer as assistant text — do not also chat_post_message the same text again.",
    "- chat_post_message: progress during tool runs, intermediate conclusions, extra bubbles, or another threadId.",
    "- chat_add_reaction / chat_start_typing / chat_send_direct_message: reactions, typing, DMs.",
    "",
    "## Prefer multiple updates",
    "- For long tasks, narrate as you go: brief chat_post_message confirmation, then tools, then more progress; put the final conclusion in assistant text so it streams automatically.",
    "- Short questions still need a final text reply.",
    "- Normal replies to the current thread do not need prior confirmation.",
    "- Match the user's language; keep it concise and readable; Markdown is fine.",
  ].join("\n");
}
