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
  description: "要发送的文本；支持 Markdown",
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
          `向当前远程会话额外发帖（默认线程 ${handle.threadId}）。`,
          "最终答复会自动流式发送到当前线程，不必再用本工具重复发一遍。",
          "适合：工具执行中的进度更新、分步结论、补充说明、或发到其他 threadId。",
          "message 用自然语言/Markdown。",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            message: MESSAGE_SCHEMA,
            threadId: {
              type: "string",
              description: `完整线程 id（如 slack:C123:ts）；默认 ${handle.threadId}`,
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
        description: "在频道发顶层消息（不挂在现有线程下）。channelId 需带平台前缀。",
        parameters: {
          type: "object",
          properties: {
            message: MESSAGE_SCHEMA,
            channelId: {
              type: "string",
              description: `完整频道 id；默认 ${handle.channelId}`,
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
        description: "打开（或复用）与用户的私信并发送消息。",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string", description: "平台用户 id" },
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
        description: "给指定消息添加 emoji 反应。",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "平台消息 id" },
            emoji: {
              type: "string",
              description: "emoji 名，如 thumbs_up / white_check_mark",
            },
            threadId: {
              type: "string",
              description: `完整线程 id；默认 ${handle.threadId}`,
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
        description: "在线程中显示正在输入指示。",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `完整线程 id；默认 ${handle.threadId}`,
            },
            status: { type: "string", description: "可选状态文案" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_FETCH_MESSAGES,
        description: "拉取线程近期消息。",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `完整线程 id；默认 ${handle.threadId}`,
            },
            limit: { type: "integer", description: "条数，默认 20" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_FETCH_THREAD,
        description: "获取线程元信息（频道、是否 DM 等）。",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: `完整线程 id；默认 ${handle.threadId}`,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_GET_CHANNEL_INFO,
        description: "获取频道元信息。",
        parameters: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: `完整频道 id；默认 ${handle.channelId}`,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_GET_USER,
        description: "按用户 id 查询资料。",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string", description: "平台用户 id" },
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
      if (message == null || message === "") throw new Error("message 不能为空");
      const threadId = str(args, "threadId") ?? handle.threadId;
      const sent = await chat.thread(threadId).post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_POST_CHANNEL_MESSAGE: {
      const message = args.message;
      if (message == null || message === "") throw new Error("message 不能为空");
      const channelId = str(args, "channelId") ?? handle.channelId;
      const sent = await chat.channel(channelId).post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_SEND_DIRECT_MESSAGE: {
      const userId = str(args, "userId");
      const message = args.message;
      if (!userId) throw new Error("userId 不能为空");
      if (message == null || message === "") throw new Error("message 不能为空");
      const dm = await chat.openDM(userId);
      const sent = await dm.post(toPostable(message));
      return { messageId: sent.id, threadId: sent.threadId };
    }
    case CHAT_ADD_REACTION: {
      const messageId = str(args, "messageId");
      const emoji = str(args, "emoji");
      if (!messageId || !emoji) throw new Error("messageId 与 emoji 必填");
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
      if (!userId) throw new Error("userId 不能为空");
      if (typeof chat.getUser !== "function") {
        throw new Error("当前 Chat 实例不支持 getUser");
      }
      return (await chat.getUser(userId)) ?? null;
    }
    default:
      throw new Error(`未知远程通道工具: ${name}`);
  }
}

export function remoteChannelPromptBlock(handle: RemoteChannelSessionHandle): string {
  return [
    "# 远程消息通道（必读）",
    `你正在 ${handle.platform} 远程会话中对话（线程 ${handle.threadId}，频道 ${handle.channelId}）。`,
    "",
    "## 如何回复用户",
    "- 用户消息到达时平台会自动贴 👀；你的最终文本答复会以真实消息流式编辑发到当前线程（工具执行期间仍保留已发出内容）。",
    "- 因此：正常最终回复直接写助手文本即可，不要再用 chat_post_message 把同一段话发第二遍。",
    "- chat_post_message：工具执行中的进度、分步结论、补充气泡，或发到其他 threadId。",
    "- chat_add_reaction / chat_start_typing / chat_send_direct_message：反应、输入状态、私信。",
    "",
    "## 鼓励多回复",
    "- 长任务边做边说：先用 chat_post_message 简短确认，再调工具，关键进度可再发；最终结论写在助手文本里自动流式发出。",
    "- 短问题也要有最终文本答复。",
    "- 对当前线程的正常回复不需要事先征求确认。",
    "- 用对方语言；简洁可读，Markdown 可用。",
  ].join("\n");
}
