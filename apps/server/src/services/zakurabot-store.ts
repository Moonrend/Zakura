import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId, tenantMemberships, tenants, users, zakurabotMessages } from "../db/schema.js";
import { ZAKURABOT_MAX_FRAME_BYTES, type ZakurabotStoredFrame, type ZakurabotUserFrame } from "./zakurabot-protocol.js";

export type ZakurabotConversation = {
  tenantId: string;
  /** OAuth 授权用户的 id；列名保留自设备时代。 */
  deviceId: string;
  bindingId: string;
  agentId: string;
};

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

  async history(c: ZakurabotConversation, limit = 100): Promise<ZakurabotStoredFrame[]> {
    const rows = await this.db.select({ frameJson: zakurabotMessages.frameJson }).from(zakurabotMessages)
      .where(this.conversationWhere(c)).orderBy(desc(zakurabotMessages.seq))
      .limit(Math.max(1, Math.min(100, limit)));
    return rows.reverse().map((r) => JSON.parse(r.frameJson) as ZakurabotStoredFrame);
  }
}
