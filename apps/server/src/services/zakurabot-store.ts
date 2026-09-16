import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId, tenants, zakurabotDevices, zakurabotMessages, type ZakurabotDevice } from "../db/schema.js";
import { ZAKURABOT_MAX_FRAME_BYTES, type ZakurabotStoredFrame, type ZakurabotUserFrame } from "./zakurabot-protocol.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type ZakurabotConversation = {
  tenantId: string;
  deviceId: string;
  bindingId: string;
  agentId: string;
};

export function deviceBindingIds(device: ZakurabotDevice): string[] {
  const value: unknown = JSON.parse(device.bindingIdsJson);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function zakurabotDeviceView(device: ZakurabotDevice) {
  return { id: device.id, name: device.name, bindingIds: deviceBindingIds(device),
    expiresAt: device.expiresAt.toISOString(), revokedAt: device.revokedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null, createdAt: device.createdAt.toISOString() };
}

export class ZakurabotStore {
  constructor(private readonly db: Db) {}

  async createDevice(tenantId: string, input: { name: string; bindingIds: string[]; expiresInDays: number }) {
    const token = `zbot_${randomBytes(32).toString("base64url")}`;
    const [device] = await this.db.insert(zakurabotDevices).values({
      tenantId, name: input.name, tokenHash: hash(token), bindingIdsJson: JSON.stringify(input.bindingIds),
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    }).returning();
    return { device: device!, token };
  }

  private async activeDevice(condition: SQL): Promise<ZakurabotDevice | null> {
    const [row] = await this.db.select({ device: zakurabotDevices }).from(zakurabotDevices)
      .innerJoin(tenants, eq(tenants.id, zakurabotDevices.tenantId))
      .where(and(condition, isNull(zakurabotDevices.revokedAt),
        gt(zakurabotDevices.expiresAt, new Date()), isNull(tenants.suspendedAt))).limit(1);
    return row?.device ?? null;
  }

  async authenticate(token: string): Promise<ZakurabotDevice | null> {
    if (!/^zbot_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const device = await this.activeDevice(eq(zakurabotDevices.tokenHash, hash(token)));
    if (device) await this.db.update(zakurabotDevices).set({ lastSeenAt: new Date() })
      .where(eq(zakurabotDevices.id, device.id));
    return device;
  }

  getActiveDevice(tenantId: string, deviceId: string) {
    return this.activeDevice(and(eq(zakurabotDevices.tenantId, tenantId), eq(zakurabotDevices.id, deviceId))!);
  }

  async listDevices(tenantId: string) {
    return this.db.select().from(zakurabotDevices).where(eq(zakurabotDevices.tenantId, tenantId))
      .orderBy(desc(zakurabotDevices.createdAt));
  }

  async revokeDevice(tenantId: string, deviceId: string): Promise<boolean> {
    const rows = await this.db.update(zakurabotDevices).set({ revokedAt: new Date() })
      .where(and(eq(zakurabotDevices.tenantId, tenantId), eq(zakurabotDevices.id, deviceId)))
      .returning();
    return rows.length > 0;
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
