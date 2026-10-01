import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messageReactions, newId, tenantMemberships, tenants, users, zakurabotMessages } from "../db/schema.js";
import { ZAKURABOT_MAX_FRAME_BYTES, type ZakurabotStoredFrame, type ZakurabotUserFrame } from "./zakurabot-protocol.js";

export type ZakurabotConversation = {
  tenantId: string;
  /** OAuth 授权用户的 id；列名保留自设备时代。 */
  deviceId: string;
  bindingId: string;
  agentId: string;
};

/** 一条已落库的会话消息及其全局递增序号；seq 同时作为向上翻页的游标。 */
export type ZakurabotHistoryItem = { seq: number; frame: ZakurabotStoredFrame };
/** 会话历史的一页：items 按 seq 升序排列；nextBefore 用于取更早的一页，null 表示已到开头。 */
export type ZakurabotHistoryPage = { items: ZakurabotHistoryItem[]; nextBefore: number | null };

export class ZakurabotStore {
  constructor(private readonly db: Db) {}

  async getActiveUser(tenantId: string, userId: string) {
    const [row] = await this.db.select({ userId: users.id, email: users.email, role: tenantMemberships.role }).from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId)).innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"), isNull(users.suspendedAt), isNull(tenants.suspendedAt))).limit(1);
    return row ?? null;
  }

  private conversationWhere(c: ZakurabotConversation) {
    return and(eq(zakurabotMessages.tenantId, c.tenantId), eq(zakurabotMessages.deviceId, c.deviceId),
      eq(zakurabotMessages.bindingId, c.bindingId), eq(zakurabotMessages.agentId, c.agentId));
  }

  async userMessage(c: ZakurabotConversation, clientMessageId: string): Promise<ZakurabotUserFrame | null> {
    const [row] = await this.db.select().from(zakurabotMessages)
      .where(and(this.conversationWhere(c), eq(zakurabotMessages.clientMessageId, clientMessageId))).limit(1);
    return row ? JSON.parse(row.frameJson) as ZakurabotUserFrame : null;
  }

  async appendMessage(c: ZakurabotConversation, frame: ZakurabotStoredFrame): Promise<ZakurabotStoredFrame> {
    const frameJson = JSON.stringify(frame);
    if (Buffer.byteLength(frameJson) > ZAKURABOT_MAX_FRAME_BYTES) throw new Error("Channel reply is too large");
    const clientMessageId = frame.type === "message" ? frame.message.clientMessageId : null;
    if (frame.type === "chat_reply" && frame.payload.interaction) {
      // Interaction resolutions replace their original card, preserving transcript order and ID.
      await this.db.insert(zakurabotMessages).values({
        id: frame.messageId, ...c, frameJson, createdAt: new Date(frame.createdAt),
      }).onConflictDoUpdate({ target: zakurabotMessages.id, set: { frameJson },
        setWhere: this.conversationWhere(c) });
      return frame;
    }
    const rows = await this.db.insert(zakurabotMessages).values({
      id: newId(), ...c, clientMessageId, frameJson,
      createdAt: new Date(frame.type === "message" ? frame.message.createdAt : frame.createdAt),
    }).onConflictDoNothing().returning();
    if (rows.length || !clientMessageId) return frame;
    const existing = await this.userMessage(c, clientMessageId);
    if (!existing) throw new Error("Channel message could not be stored");
    return existing;
  }

  async history(c: ZakurabotConversation, limit = 100, beforeSeq?: number): Promise<ZakurabotHistoryPage> {
    const capped = Math.max(1, Math.min(100, limit));
    const where = beforeSeq === undefined ? this.conversationWhere(c)
      : and(this.conversationWhere(c), lt(zakurabotMessages.seq, beforeSeq));
    // 多取一条仅用于判断是否还有更早的消息，返回时丢弃。
    const rows = await this.db.select({ seq: zakurabotMessages.seq, frameJson: zakurabotMessages.frameJson }).from(zakurabotMessages)
      .where(where).orderBy(desc(zakurabotMessages.seq)).limit(capped + 1);
    const items = rows.slice(0, capped).reverse()
      .map((r) => ({ seq: r.seq, frame: JSON.parse(r.frameJson) as ZakurabotStoredFrame }));
    return { items, nextBefore: rows.length > capped ? items[0]!.seq : null };
  }

  private reactionWhere(c: ZakurabotConversation, messageId: string, userId: string) {
    return and(eq(messageReactions.tenantId, c.tenantId), eq(messageReactions.deviceId, c.deviceId),
      eq(messageReactions.bindingId, c.bindingId), eq(messageReactions.agentId, c.agentId),
      eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId));
  }

  async addReaction(c: ZakurabotConversation, messageId: string, userId: string, emoji: string) {
    const [row] = await this.db.insert(messageReactions).values({ tenantId: c.tenantId, deviceId: c.deviceId,
      bindingId: c.bindingId, agentId: c.agentId, messageId, userId, emoji })
      .onConflictDoUpdate({ target: [messageReactions.tenantId, messageReactions.deviceId, messageReactions.bindingId,
        messageReactions.agentId, messageReactions.messageId, messageReactions.userId], set: { emoji } }).returning();
    return row!;
  }

  async removeReaction(c: ZakurabotConversation, messageId: string, userId: string, emoji: string) {
    const [row] = await this.db.delete(messageReactions)
      .where(and(this.reactionWhere(c, messageId, userId), eq(messageReactions.emoji, emoji))).returning();
    return row ?? null;
  }

  async reactions(c: ZakurabotConversation, messageId: string) {
    return this.db.select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji,
      userId: messageReactions.userId, createdAt: messageReactions.createdAt }).from(messageReactions)
      .where(and(eq(messageReactions.tenantId, c.tenantId), eq(messageReactions.deviceId, c.deviceId),
        eq(messageReactions.bindingId, c.bindingId), eq(messageReactions.agentId, c.agentId),
        eq(messageReactions.messageId, messageId)));
  }
}
