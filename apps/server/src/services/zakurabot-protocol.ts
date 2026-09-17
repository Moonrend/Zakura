/** Wire contract: Moonrend/zakura-bot@786d427, lib/channel/protocol.ts. */
import { basename } from "node:path";
import { z } from "zod";

export const ZAKURABOT_PROTOCOL = 1;
export const ZAKURABOT_MAX_FRAME_BYTES = 1_000_000;
export const ZAKURABOT_MAX_TEXT = 4000;
export const ZAKURABOT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export const channelIdSchema = z.string().min(1).max(256).refine(
  (id) => Boolean(id.trim()) && !/[\u0000-\u001f\u007f]/.test(id) &&
    id !== "prototype" && !Object.hasOwn(Object.prototype, id),
);
export const zakurabotHttpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, "Expected an HTTP(S) URL without credentials");
const httpUrl = zakurabotHttpUrlSchema;

export type ZakurabotFileView = {
  id: string; name: string; mime: string; size: number;
  type: "image" | "file" | "audio" | "video"; url: string;
};
const linkSchema = z.object({
  label: z.string().trim().min(1),
  url: httpUrl,
  style: z.enum(["primary", "danger", "default"]).optional(),
});
const cardSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  text: z.string().optional(),
  imageUrl: httpUrl.optional(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  images: z.array(z.object({ url: httpUrl, alt: z.string().optional() })).optional(),
  links: z.array(linkSchema).optional(),
  table: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) }).optional(),
}).refine((c) => Boolean(c.title || c.subtitle || c.text || c.imageUrl || c.fields?.length ||
  c.images?.length || c.links?.length || c.table?.rows.length), "Empty card");
const attachmentSchema = z.object({
  url: httpUrl,
  name: z.string().optional(),
  type: z.enum(["image", "file", "audio", "video"]).optional(),
});
const attachmentInputSchema = z.object({
  url: httpUrl.optional(),
  path: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  type: attachmentSchema.shape.type,
}).refine((item) => Boolean(item.url || item.path), "attachment needs path or url");
const replyFieldsSchema = z.object({
  text: z.string().optional(),
  format: z.enum(["markdown", "raw"]).optional(),
  kind: z.enum(["markdown", "raw", "card"]).optional(),
  reply_to: channelIdSchema.optional(),
  attachments: z.array(attachmentSchema).max(8).optional(),
  actions: z.array(linkSchema).optional(),
  card: cardSchema.optional(),
}).refine((p) => p.kind !== "card" || Boolean(p.card), "kind=card requires a card");
export const zakurabotReplySchema = replyFieldsSchema.refine(
  (p) => Boolean(p.text?.trim() || p.attachments?.length || p.actions?.length || p.card), "Empty reply",
);

export const zakurabotClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(ZAKURABOT_PROTOCOL),
    token: z.string().min(1).max(256),
    client: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(128) }),
  }),
  z.object({ type: z.literal("send"), agentId: channelIdSchema, clientMessageId: channelIdSchema,
    text: z.string().trim().max(ZAKURABOT_MAX_TEXT).default(""),
    attachments: z.array(z.object({ fileId: channelIdSchema }).strict()).min(1).max(8)
      .refine((files) => new Set(files.map((f) => f.fileId)).size === files.length).optional() }),
  z.object({ type: z.literal("interrupt"), agentId: channelIdSchema }),
  z.object({ type: z.literal("ping") }),
]).refine((frame) => frame.type !== "send" || Boolean(frame.text || frame.attachments?.length), "Empty message");

export type ZakurabotClientFrame = z.infer<typeof zakurabotClientFrameSchema>;
export type ZakurabotReply = z.infer<typeof zakurabotReplySchema>;
export type ZakurabotAgent = { id: string; name: string; status: "idle" | "busy" | "offline";
  color: string; unread: boolean; title?: string; bindingId?: string; description?: string;
  capabilities?: { files: boolean; desktop: boolean; interactions: boolean } };
export type ZakurabotUserFrame = { type: "message"; message: {
  id: string; agentId: string; role: "user"; kind: "text"; text: string;
  clientMessageId: string; createdAt: number;
  attachments?: ZakurabotFileView[];
} };
export type ZakurabotReplyFrame = { type: "chat_reply"; agentId: string; messageId: string;
  createdAt: number; payload: ZakurabotReply };
export type ZakurabotStoredFrame = ZakurabotUserFrame | ZakurabotReplyFrame;
export type ZakurabotToolFrame = { type: "tool_activity"; agentId: string; message: {
  id: string; agentId: string; role: "assistant"; kind: "activity"; createdAt: number;
  tool: { name: string; ok?: boolean; detail?: string; interrupted?: boolean };
} };
export type ZakurabotServerFrame = ZakurabotStoredFrame | ZakurabotToolFrame |
  { type: "ready"; protocol: number; agents: ZakurabotAgent[]; capabilities?: string[] } |
  { type: "agents"; agents: ZakurabotAgent[] } |
  { type: "typing"; agentId: string; active: boolean } |
  { type: "error"; message: string; agentId?: string; clientMessageId?: string; fatal?: boolean } |
  { type: "pong" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mediaType(name: string): "image" | "audio" | "video" | "file" {
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)) return "image";
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(name)) return "audio";
  if (/\.(mp4|webm|mov)$/i.test(name)) return "video";
  return "file";
}

/** Preserve the native card/button shape; only local attachments need publication. */
export async function encodeZakurabotReply(
  args: Record<string, unknown>,
  publishFile: (path: string) => Promise<{ url: string; name: string }>,
): Promise<ZakurabotReply> {
  const nested = record(args.message);
  const text = typeof args.message === "string" ? args.message :
    nested.markdown ?? nested.raw ?? nested.text ?? args.text ?? args.markdown ?? args.raw;
  const kind = args.kind ?? args.format ?? (nested.raw !== undefined || args.raw !== undefined ? "raw" : "markdown");
  const rawAttachments = args.attachments ?? nested.attachments ?? [];
  const items = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
  if (items.length > 8) throw new Error("最多 8 个附件");
  const sources = z.array(attachmentInputSchema).parse(items.map((item) => typeof item === "string"
    ? (/^https?:\/\//i.test(item) ? { url: item } : { path: item }) : item));
  // Validate all non-file fields before creating any public shares.
  const card = args.card === undefined ? undefined : {
    ...record(args.card),
    links: record(args.card).links ?? record(args.card).actions,
  };
  const base = replyFieldsSchema.parse({
    text, kind: kind === "plain" ? "raw" : kind, card,
    actions: args.actions ?? nested.actions,
  });
  const attachments: z.infer<typeof attachmentSchema>[] = [];
  for (const row of sources) {
    let url: string;
    let name: string;
    if (row.url !== undefined) {
      url = httpUrl.parse(row.url);
      name = basename(new URL(url).pathname) || "file";
    } else {
      const path = row.path!;
      const published = await publishFile(path.startsWith("/") ? path : `/workspace/${path.replace(/^\.\//, "")}`);
      url = httpUrl.parse(published.url);
      name = published.name;
    }
    attachments.push(attachmentSchema.parse({ url, name: row.name ?? name, type: row.type ?? mediaType(name) }));
  }
  return zakurabotReplySchema.parse({ ...base, attachments: attachments.length ? attachments : undefined });
}
