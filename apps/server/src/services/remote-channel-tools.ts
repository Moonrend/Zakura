/**
 * 远程通道工具面：对齐 Chat SDK `createChatTools({ preset: "messenger" })`，
 * 让 Agent 用 chat_reply（可多次）发 text / 附件 / URL 按钮 / card，而不是镜像 assistant 文本。
 *
 * 不引入 `ai` 包；直接调用 Chat.thread / channel / openDM。
 */
import { basename } from "node:path";
import {
  Actions,
  Card,
  CardText,
  Fields,
  Field,
  Image,
  LinkButton,
  Table,
} from "chat";
import { textResult } from "@zakura/core";
import type { McpToolResult } from "@zakura/shared";
import type { ModelToolDefinition } from "@zakura/shared";

export const CHAT_REPLY = "chat_reply";
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
  CHAT_REPLY,
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
  /** First-party transports can preserve their native wire payload instead of Chat SDK cards. */
  encodePostable?(args: Record<string, unknown>, ctx?: EncodePostableContext): Promise<unknown>;
  thread(threadId: string): {
    id: string;
    channelId: string;
    isDM: boolean;
    post(message: unknown): Promise<{ id: string; threadId: string }>;
    reply?(
      target: string | { id: string },
      message: unknown,
    ): Promise<{ id: string; threadId: string }>;
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

export type RemoteChannelTrigger = "dm" | "mention" | "subscribed";

export type RemoteChannelSender = {
  userId?: string;
  userName?: string;
  fullName?: string;
};

export type RemoteChannelSessionHandle = {
  chat: RemoteChatHandle;
  /** 入站线程完整 id，例如 slack:C123:1234567890.123456 */
  threadId: string;
  channelId: string;
  platform: string;
  bindingId: string;
  /** 触发本回合的用户消息 id，chat_reply 默认 quote */
  inboundMessageId?: string;
  /** 是否私信 */
  isDM?: boolean;
  /** 频道显示名（非 DM 时） */
  channelName?: string;
  /** 是否线程内（相对频道顶层） */
  isThread?: boolean;
  /** 发言人 */
  sender?: RemoteChannelSender;
  /** 入站触发方式 */
  trigger?: RemoteChannelTrigger;
  /** 原消息链接（若平台提供） */
  permalink?: string;
  /**
   * 本回合成功 chat_reply 次数。bind 时置 0；成功发出后 +1。
   * 供静默回合自动补发判断，勿手动改。
   */
  chatReplySuccessCount?: number;
  /** 已做过静默自动补发，防止重复刷屏 */
  autoFallbackPosted?: boolean;
};

export type EncodePostableContext = {
  readWorkspaceFile?: (path: string) => Promise<{ data: Buffer; name: string }>;
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

const CARD_SCHEMA = {
  type: "object",
  description: "Structured card: title, fields, table, images, link buttons",
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    imageUrl: { type: "string", description: "Header image URL" },
    text: { type: "string", description: "Card body text" },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
        },
        required: ["label", "value"],
      },
    },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          alt: { type: "string" },
        },
        required: ["url"],
      },
    },
    table: {
      type: "object",
      properties: {
        headers: { type: "array", items: { type: "string" } },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["headers", "rows"],
    },
    links: {
      type: "array",
      description: "URL buttons",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          url: { type: "string" },
          style: { type: "string", enum: ["primary", "danger", "default"] },
        },
        required: ["label", "url"],
      },
    },
  },
} as const;

const ATTACHMENT_ITEM_SCHEMA = {
  anyOf: [
    { type: "string", description: "Workspace path or public http(s) URL" },
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path, e.g. /workspace/out/report.pdf" },
        url: { type: "string", description: "Public http(s) URL the platform can fetch" },
        name: { type: "string" },
        type: { type: "string", enum: ["image", "file", "audio", "video"] },
      },
    },
  ],
} as const;

const ACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    url: { type: "string" },
    style: { type: "string", enum: ["primary", "danger", "default"] },
  },
  required: ["label", "url"],
} as const;

const POSTABLE_PROPERTIES = {
  text: {
    type: "string",
    description: "Message body. Ordinary Markdown goes here; omit only when sending files/buttons alone.",
  },
  format: {
    type: "string",
    enum: ["markdown", "raw"],
    description: "How to render text. Default markdown.",
  },
  kind: {
    type: "string",
    enum: ["markdown", "raw", "card"],
    description: "Alias of format; kind=card sends a structured card",
  },
  reply_to: {
    type: "string",
    description: "Platform message id to quote. chat_reply defaults to the inbound user message.",
  },
  attachments: {
    type: "array",
    description: "Files: workspace paths, public URLs, or {path|url, name?, type?}",
    items: ATTACHMENT_ITEM_SCHEMA,
  },
  actions: {
    type: "array",
    description: "URL buttons (ignored on platforms without buttons)",
    items: ACTION_ITEM_SCHEMA,
  },
  card: CARD_SCHEMA,
} as const;

export function listRemoteChannelToolDefinitions(
  handle: RemoteChannelSessionHandle,
): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: CHAT_REPLY,
        description: [
          `在当前 ${handle.platform} 会话发一条用户可见消息（唯一可靠出口）。`,
          "不调用则外部用户看不到任何内容——assistant 文本不会出现在 Slack/Telegram 等平台。",
          "可多次调用：短确认 → 进度 → 附件/结论。长任务禁止只跑工具不 chat_reply。",
          "text=Markdown 正文；attachments=工作区路径或 URL；actions=链接按钮；card=结构化卡片；reply_to 默认引用入站消息。",
          "不要对用户复述内部 id（threadId/channelId/bindingId）。",
        ].join(" "),
        parameters: {
          type: "object",
          properties: POSTABLE_PROPERTIES,
        },
      },
    },
    {
      type: "function",
      function: {
        name: CHAT_POST_MESSAGE,
        description: [
          "Post to another thread, or an extra bubble besides chat_reply.",
          `Default thread is ${handle.threadId}. Prefer chat_reply for replies to the current user.`,
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            ...POSTABLE_PROPERTIES,
            threadId: {
              type: "string",
              description: `Full thread id (e.g. slack:C123:ts); default ${handle.threadId}`,
            },
          },
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
            ...POSTABLE_PROPERTIES,
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
        name: CHAT_SEND_DIRECT_MESSAGE,
        description: "Open (or reuse) a DM with a user and send a message.",
        parameters: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Platform user id" },
            ...POSTABLE_PROPERTIES,
          },
          required: ["userId"],
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function styleOf(value: unknown): "primary" | "danger" | "default" | undefined {
  return value === "primary" || value === "danger" || value === "default" ? value : undefined;
}

function buildCard(spec: Record<string, unknown>) {
  const children: unknown[] = [];
  const body = str(spec, "text");
  if (body) children.push(CardText(body));

  const fieldItems = Array.isArray(spec.fields) ? spec.fields : [];
  const fields = fieldItems.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const label = str(row, "label");
    const value = str(row, "value");
    return label && value ? [Field({ label, value })] : [];
  });
  if (fields.length) children.push(Fields(fields) as never);

  const images = Array.isArray(spec.images) ? spec.images : [];
  for (const item of images) {
    const row = asRecord(item);
    const url = row ? str(row, "url") : undefined;
    if (!url) continue;
    children.push(Image({ url, alt: row ? str(row, "alt") : undefined }) as never);
  }

  const table = asRecord(spec.table);
  if (table && Array.isArray(table.headers) && Array.isArray(table.rows)) {
    const headers = table.headers.map((h) => String(h ?? ""));
    const rows = table.rows
      .filter(Array.isArray)
      .map((row) => (row as unknown[]).map((cell) => String(cell ?? "")));
    if (headers.length) children.push(Table({ headers, rows }) as never);
  }

  const linkItems = Array.isArray(spec.links)
    ? spec.links
    : Array.isArray(spec.actions)
      ? spec.actions
      : [];
  const links = linkItems.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const label = str(row, "label");
    const url = str(row, "url");
    return label && url ? [LinkButton({ label, url, style: styleOf(row.style) })] : [];
  });
  if (links.length) children.push(Actions(links) as never);

  const title = str(spec, "title");
  const subtitle = str(spec, "subtitle");
  const imageUrl = str(spec, "imageUrl");
  if (!children.length && !title && !subtitle && !imageUrl) {
    throw new Error("card needs title, text, fields, table, images, or links");
  }
  return Card({
    title,
    subtitle,
    imageUrl,
    children: children as never,
  });
}

function bodyText(args: Record<string, unknown>): string | undefined {
  const message = args.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const msgObj = asRecord(message);
  if (msgObj) {
    const nested =
      (typeof msgObj.markdown === "string" && msgObj.markdown.trim()) ||
      (typeof msgObj.raw === "string" && msgObj.raw.trim()) ||
      (typeof msgObj.text === "string" && msgObj.text.trim());
    if (nested) return nested;
  }
  return str(args, "text") ?? str(args, "markdown") ?? str(args, "raw");
}

function parseActions(args: Record<string, unknown>): Array<Record<string, unknown>> {
  const fromArgs = Array.isArray(args.actions) ? args.actions : [];
  const fromMessage = Array.isArray(asRecord(args.message)?.actions)
    ? (asRecord(args.message)!.actions as unknown[])
    : [];
  const rows = fromArgs.length ? fromArgs : fromMessage;
  return rows.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const label = str(row, "label");
    const url = str(row, "url");
    return label && url ? [{ label, url, style: row.style }] : [];
  });
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

function mediaKind(
  name: string,
  explicit?: string,
): "image" | "audio" | "video" | "file" {
  if (explicit === "image" || explicit === "audio" || explicit === "video" || explicit === "file") {
    return explicit;
  }
  if (IMAGE_EXT.test(name)) return "image";
  if (AUDIO_EXT.test(name)) return "audio";
  if (VIDEO_EXT.test(name)) return "video";
  return "file";
}

function guessMime(name: string, kind: string): string | undefined {
  if (kind === "image") {
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".gif")) return "image/gif";
    if (name.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return undefined;
}

function normalizeAttachPath(path: string): string {
  return path.replace(/^workspace:/, "").trim();
}

type ResolvedMedia = {
  files: Array<{ data: Buffer; filename: string; mimeType?: string }>;
  attachments: Array<{
    type: "image" | "file" | "audio" | "video";
    data?: Buffer;
    url?: string;
    name?: string;
    mimeType?: string;
  }>;
  imageUrls: string[];
};

async function resolveMedia(
  args: Record<string, unknown>,
  ctx?: EncodePostableContext,
): Promise<ResolvedMedia> {
  const raw = args.attachments ?? asRecord(args.message)?.attachments;
  const items = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  if (items.length > MAX_ATTACHMENTS) {
    throw new Error(`最多 ${MAX_ATTACHMENTS} 个附件`);
  }
  const out: ResolvedMedia = { files: [], attachments: [], imageUrls: [] };
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      if (/^https?:\/\//i.test(item.trim())) {
        const name = basename(new URL(item.trim()).pathname) || "file";
        const kind = mediaKind(name);
        if (kind === "image") out.imageUrls.push(item.trim());
        out.attachments.push({ type: kind, url: item.trim(), name });
        continue;
      }
      const file = await readWorkspace(item.trim(), ctx);
      pushLocalFile(out, file, undefined);
      continue;
    }
    const row = asRecord(item);
    if (!row) continue;
    const url = str(row, "url");
    const path = str(row, "path");
    const name = str(row, "name");
    const explicit = str(row, "type");
    if (url && /^https?:\/\//i.test(url)) {
      const filename = name || basename(new URL(url).pathname) || "file";
      const kind = mediaKind(filename, explicit);
      if (kind === "image") out.imageUrls.push(url);
      out.attachments.push({ type: kind, url, name: filename });
      continue;
    }
    if (path) {
      const file = await readWorkspace(path, ctx);
      pushLocalFile(out, { ...file, name: name || file.name }, explicit);
      continue;
    }
    throw new Error("attachment needs path or url");
  }
  return out;
}

async function readWorkspace(
  path: string,
  ctx?: EncodePostableContext,
): Promise<{ data: Buffer; name: string }> {
  if (!ctx?.readWorkspaceFile) {
    throw new Error("工作区未就绪，无法发送本地附件");
  }
  const file = await ctx.readWorkspaceFile(normalizeAttachPath(path));
  if (file.data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件过大（上限 16MB）：${file.name}`);
  }
  if (!file.data.length) throw new Error(`附件为空：${path}`);
  return file;
}

function pushLocalFile(
  out: ResolvedMedia,
  file: { data: Buffer; name: string },
  explicit?: string,
) {
  const kind = mediaKind(file.name, explicit);
  const mimeType = guessMime(file.name, kind);
  if (kind === "file") {
    out.files.push({ data: file.data, filename: file.name, mimeType });
    return;
  }
  out.attachments.push({ type: kind, data: file.data, name: file.name, mimeType });
}

function withCardFiles(card: unknown, media: ResolvedMedia, fallback?: string) {
  const files = [
    ...media.files,
    ...media.attachments.flatMap((a) =>
      a.data ? [{ data: a.data, filename: a.name || "file", mimeType: a.mimeType }] : [],
    ),
  ];
  if (!files.length) return card;
  return { card, files, ...(fallback ? { fallbackText: fallback } : {}) };
}

/** 把工具参数编成 Chat SDK PostableMessage（markdown / raw / card + 附件）。 */
export async function encodePostable(
  args: Record<string, unknown>,
  ctx?: EncodePostableContext,
): Promise<unknown> {
  const media = await resolveMedia(args, ctx);
  const actions = parseActions(args);
  const kind = (str(args, "kind") ?? str(args, "format") ?? "").toLowerCase();
  const cardSpec = asRecord(args.card);
  const text = bodyText(args);

  if (kind === "card" || cardSpec || actions.length) {
    const spec: Record<string, unknown> = { ...(cardSpec ?? {}) };
    if (!str(spec, "text") && text) spec.text = text;
    if (actions.length && !spec.links && !spec.actions) spec.links = actions;
    if (media.imageUrls.length && !spec.images) {
      spec.images = media.imageUrls.map((url) => ({ url }));
    }
    const card = buildCard(spec);
    return withCardFiles(card, media, text);
  }

  if (!text && !media.files.length && !media.attachments.length) {
    throw new Error("text, attachments, or actions required");
  }

  const payload: Record<string, unknown> =
    kind === "raw" || kind === "plain" ? { raw: text ?? "" } : { markdown: text ?? "" };
  if (media.files.length) payload.files = media.files;
  if (media.attachments.length) payload.attachments = media.attachments;
  return payload;
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

function deliveredLabel(handle: RemoteChannelSessionHandle, threadId: string): string {
  return threadId === handle.threadId ? "current_conversation" : "target";
}

async function postThread(
  handle: RemoteChannelSessionHandle,
  threadId: string,
  args: Record<string, unknown>,
  ctx: EncodePostableContext | undefined,
  quoteDefault: boolean,
): Promise<{ ok: true; messageId: string; message_id: string; threadId: string; delivered: string }> {
  const body = await encodeForChat(handle.chat, args, ctx);
  const thread = handle.chat.thread(threadId);
  const replyTo = str(args, "reply_to") ?? (quoteDefault ? handle.inboundMessageId : undefined);
  const sent =
    replyTo && typeof thread.reply === "function"
      ? await thread.reply(replyTo, body)
      : await thread.post(body);
  return {
    ok: true,
    messageId: sent.id,
    message_id: sent.id,
    threadId: sent.threadId,
    delivered: deliveredLabel(handle, sent.threadId || threadId),
  };
}

export async function callRemoteChannelTool(
  handle: RemoteChannelSessionHandle,
  name: string,
  args: Record<string, unknown>,
  ctx?: EncodePostableContext,
): Promise<McpToolResult> {
  try {
    const result = await dispatch(handle, name, args, ctx);
    if (name === CHAT_REPLY) {
      handle.chatReplySuccessCount = (handle.chatReplySuccessCount ?? 0) + 1;
    }
    return textResult(JSON.stringify(result), false);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

function encodeForChat(chat: RemoteChatHandle, args: Record<string, unknown>, ctx?: EncodePostableContext) {
  return chat.encodePostable ? chat.encodePostable(args, ctx) : encodePostable(args, ctx);
}

async function dispatch(
  handle: RemoteChannelSessionHandle,
  name: string,
  args: Record<string, unknown>,
  ctx?: EncodePostableContext,
): Promise<unknown> {
  const { chat } = handle;
  switch (name) {
    case CHAT_REPLY:
      return postThread(handle, handle.threadId, args, ctx, true);
    case CHAT_POST_MESSAGE: {
      const threadId = str(args, "threadId") ?? handle.threadId;
      return postThread(handle, threadId, args, ctx, false);
    }
    case CHAT_POST_CHANNEL_MESSAGE: {
      const channelId = str(args, "channelId") ?? handle.channelId;
      const sent = await chat.channel(channelId).post(await encodeForChat(chat, args, ctx));
      return {
        ok: true,
        messageId: sent.id,
        message_id: sent.id,
        threadId: sent.threadId,
        delivered: "target",
      };
    }
    case CHAT_SEND_DIRECT_MESSAGE: {
      const userId = str(args, "userId");
      if (!userId) throw new Error("userId is required");
      const dm = await chat.openDM(userId);
      const sent = await dm.post(await encodeForChat(chat, args, ctx));
      return {
        ok: true,
        messageId: sent.id,
        message_id: sent.id,
        threadId: sent.threadId,
        delivered: "target",
      };
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

function locationLines(handle: RemoteChannelSessionHandle): string[] {
  const where = handle.isDM
    ? "私信（DM）"
    : handle.channelName
      ? `频道 #${handle.channelName}`
      : "频道（名称未知）";
  const shape = handle.isDM ? "一对一对话" : handle.isThread ? "线程内回复" : "频道顶层";
  const sender =
    handle.sender?.fullName ||
    handle.sender?.userName ||
    handle.sender?.userId ||
    "未知用户";
  const at =
    handle.sender?.userName && handle.sender.userName !== sender
      ? `（@${handle.sender.userName}）`
      : "";
  const triggerLabel =
    handle.trigger === "dm"
      ? "私信"
      : handle.trigger === "mention"
        ? "@提及"
        : handle.trigger === "subscribed"
          ? "订阅频道消息"
          : "未知";
  const lines = [
    `平台：${handle.platform}`,
    `位置：${where} · ${shape}`,
    `对方：${sender}${at}`,
    `触发：${triggerLabel}`,
  ];
  if (handle.permalink) lines.push(`链接：${handle.permalink}`);
  return lines;
}

/** 入站用户回合前的一行来源标签（勿淹没正文） */
export function formatRemoteInboundPrefix(
  handle: Pick<
    RemoteChannelSessionHandle,
    "platform" | "isDM" | "channelName" | "isThread" | "sender" | "trigger"
  >,
): string {
  const place = handle.isDM
    ? "DM"
    : handle.channelName
      ? `#${handle.channelName}`
      : "频道";
  const shape = handle.isDM ? "" : handle.isThread ? "·线程" : "·顶层";
  const who =
    handle.sender?.fullName ||
    handle.sender?.userName ||
    handle.sender?.userId ||
    "未知";
  const trigger =
    handle.trigger === "dm"
      ? "dm"
      : handle.trigger === "mention"
        ? "mention"
        : handle.trigger === "subscribed"
          ? "subscribed"
          : "?";
  return `[来源: ${handle.platform} · ${place}${shape} · ${who} · 触发:${trigger}]`;
}

/**
 * 回合结束仍无成功 chat_reply 时，把最后一段 assistant 文本（或短兜底）经 chat_reply 补发一次。
 * 可测、防重复：已有成功回复或已补发则跳过。
 */
export async function maybeAutoChatReplyOnSilentRun(
  handle: RemoteChannelSessionHandle,
  lastAssistantText: string | undefined | null,
  opts?: { fallbackText?: string },
  ctx?: EncodePostableContext,
): Promise<{ posted: boolean; reason: string }> {
  if ((handle.chatReplySuccessCount ?? 0) > 0) {
    return { posted: false, reason: "already_replied" };
  }
  if (handle.autoFallbackPosted) {
    return { posted: false, reason: "already_fallback" };
  }
  handle.autoFallbackPosted = true;
  const fallbackText =
    typeof opts?.fallbackText === "string" && opts.fallbackText.trim()
      ? opts.fallbackText.trim()
      : undefined;
  const text =
    (typeof lastAssistantText === "string" && lastAssistantText.trim()) ||
    fallbackText ||
    "（本回合已完成，但未发出可见回复。）";
  const result = await callRemoteChannelTool(handle, CHAT_REPLY, { text }, ctx);
  if (result.isError) {
    handle.autoFallbackPosted = false;
    return { posted: false, reason: "post_failed" };
  }
  return { posted: true, reason: "auto_fallback" };
}

export function remoteChannelPromptBlock(handle: RemoteChannelSessionHandle): string {
  return [
    "# 远程消息通道（必读）",
    "",
    "## 你现在在哪",
    ...locationLines(handle).map((line) => `- ${line}`),
    "",
    "## 如何回复用户（强制）",
    "- **任何要对用户可见的文字，都必须调用 chat_reply**。只写 assistant 文本不会出现在外部聊天平台。",
    "- 可多次 chat_reply：短确认 → 干活 → 进度 → 最终结论。长任务禁止只跑工具不发消息。",
    "- 短问题也至少一次 chat_reply。匹配用户语言，简洁。",
    "- text 写普通 Markdown；attachments 用工作区路径或公开 URL；actions 为链接按钮；card 为结构化卡片。",
    "- chat_reply 默认引用入站消息；需要时可传 reply_to。",
    "- chat_post_message / chat_post_channel_message / chat_send_direct_message：发到其他线程、频道或私信。",
    "- chat_add_reaction / chat_start_typing：表情与输入状态。",
    "",
    "## 何时查阅上下文",
    "- chat_fetch_messages / chat_fetch_thread：需要回顾近期对话或确认线程信息时。",
    "- chat_get_channel_info：需要频道名、人数、可见性时。",
    "- chat_get_user：需要对方资料时。",
    "",
    "## 注意",
    "- 不要对用户复述内部 id（threadId、channelId、bindingId、sessionId）。",
    "- 用户可见结论必须经 chat_reply，不要倾倒原始 JSON 或全部中间过程。",
  ].join("\n");
}
