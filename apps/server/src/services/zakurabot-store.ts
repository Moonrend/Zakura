import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId, tenantMemberships, tenants, users, zakurabotAuthorizations, zakurabotDevices, zakurabotMessages, type ZakurabotDevice } from "../db/schema.js";
import { ZAKURABOT_MAX_FRAME_BYTES, type ZakurabotStoredFrame, type ZakurabotUserFrame } from "./zakurabot-protocol.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const userCodeHash = (code: string) => hash(code.toUpperCase().replace(/[-\s]/g, ""));
const ACCESS_SECONDS = 1800;
const activeOwner = () => or(isNull(zakurabotDevices.userId), and(isNotNull(users.id), isNull(users.suspendedAt),
  eq(tenantMemberships.status, "active")));

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
  return { id: device.id, name: device.name, userId: device.userId, bindingIds: deviceBindingIds(device),
    expiresAt: device.expiresAt.toISOString(), revokedAt: device.revokedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null, createdAt: device.createdAt.toISOString() };
}

export class ZakurabotStore {
  constructor(private readonly db: Db) {}

  async beginAuthorization(name: string, codeChallenge?: string) {
    await this.db.delete(zakurabotAuthorizations).where(lt(zakurabotAuthorizations.expiresAt, new Date()));
    const deviceCode = randomBytes(32).toString("base64url");
    const code = randomBytes(5).toString("hex").toUpperCase();
    const userCode = `${code.slice(0, 5)}-${code.slice(5)}`;
    await this.db.insert(zakurabotAuthorizations).values({ codeHash: hash(deviceCode),
      userCodeHash: userCodeHash(userCode), name, codeChallenge, expiresAt: new Date(Date.now() + 600_000) });
    return { device_code: deviceCode, user_code: userCode, expires_in: 600, interval: 5 };
  }

  async authorizationInfo(code: string) {
    const [row] = await this.db.select().from(zakurabotAuthorizations).where(and(
      eq(zakurabotAuthorizations.userCodeHash, userCodeHash(code)),
      eq(zakurabotAuthorizations.status, "pending"), gt(zakurabotAuthorizations.expiresAt, new Date()),
    )).limit(1);
    return row ? { name: row.name, expiresAt: row.expiresAt.toISOString() } : null;
  }

  async decideAuthorization(code: string, deviceId: string | null) {
    const rows = await this.db.update(zakurabotAuthorizations).set({
      status: deviceId ? "approved" : "denied", deviceId,
    }).where(and(eq(zakurabotAuthorizations.userCodeHash, userCodeHash(code)),
      eq(zakurabotAuthorizations.status, "pending"), gt(zakurabotAuthorizations.expiresAt, new Date()))).returning();
    if (deviceId && rows[0]) await this.db.update(zakurabotDevices).set({ expiresAt: rows[0].expiresAt })
      .where(and(eq(zakurabotDevices.id, deviceId), isNull(zakurabotDevices.refreshTokenHash)));
    return rows.length > 0;
  }

  private async credentials(device: ZakurabotDevice, accessToken: string, refreshToken: string) {
    const [tenant] = await this.db.select({ id: tenants.id, name: tenants.name }).from(tenants)
      .where(eq(tenants.id, device.tenantId)).limit(1);
    const user = device.userId ? await this.getActiveUser(device.tenantId, device.userId) : null;
    return { token_type: "Bearer", scope: "zakurabot", access_token: accessToken, refresh_token: refreshToken,
      expires_in: ACCESS_SECONDS, refresh_expires_at: device.refreshExpiresAt!.toISOString(),
      device: zakurabotDeviceView(device), tenant, user: user ? { id: user.userId, email: user.email } : null };
  }

  async redeemAuthorization(deviceCode: string, codeVerifier?: string) {
    const token = `zbot_${randomBytes(32).toString("base64url")}`;
    const refresh = `zbrt_${randomBytes(32).toString("base64url")}`;
    const result = await this.db.transaction(async (tx): Promise<{ device?: ZakurabotDevice; error?: string; interval?: number }> => {
      const [grant] = await tx.select().from(zakurabotAuthorizations)
        .where(eq(zakurabotAuthorizations.codeHash, hash(deviceCode))).limit(1).for("update");
      const now = new Date();
      if (!grant || grant.expiresAt <= now) return { error: "expired_token" };
      // Existing v1 clients use the device-code grant without PKCE. A grant that
      // opted into S256 must always prove possession, including after a restart.
      if (grant.codeChallenge && (!codeVerifier || createHash("sha256").update(codeVerifier).digest("base64url") !== grant.codeChallenge)) {
        return { error: "invalid_grant" };
      }
      if (grant.status === "denied") return { error: "access_denied" };
      if (grant.status === "consumed") return { error: "invalid_grant" };
      if (grant.lastPolledAt && now.getTime() < grant.lastPolledAt.getTime() + grant.intervalSeconds * 1000) {
        const interval = Math.min(60, grant.intervalSeconds + 5);
        await tx.update(zakurabotAuthorizations).set({ lastPolledAt: now, intervalSeconds: interval })
          .where(eq(zakurabotAuthorizations.codeHash, grant.codeHash));
        return { error: "slow_down", interval };
      }
      await tx.update(zakurabotAuthorizations).set({ lastPolledAt: now })
        .where(eq(zakurabotAuthorizations.codeHash, grant.codeHash));
      if (grant.status === "pending") return { error: "authorization_pending", interval: grant.intervalSeconds };
      if (!grant.deviceId) return { error: "invalid_grant" };
      await tx.update(zakurabotAuthorizations).set({ status: "consumed" })
        .where(eq(zakurabotAuthorizations.codeHash, grant.codeHash));
      const [active] = await tx.select({ id: zakurabotDevices.id }).from(zakurabotDevices)
        .innerJoin(tenants, eq(tenants.id, zakurabotDevices.tenantId))
        .leftJoin(users, eq(users.id, zakurabotDevices.userId))
        .leftJoin(tenantMemberships, and(eq(tenantMemberships.userId, zakurabotDevices.userId), eq(tenantMemberships.tenantId, zakurabotDevices.tenantId)))
        .where(and(eq(zakurabotDevices.id, grant.deviceId), isNull(zakurabotDevices.revokedAt),
          gt(zakurabotDevices.expiresAt, now), isNull(tenants.suspendedAt), activeOwner())).limit(1);
      if (!active) return { error: "invalid_grant" };
      const [device] = await tx.update(zakurabotDevices).set({ tokenHash: hash(token), refreshTokenHash: hash(refresh),
        expiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000), refreshExpiresAt: new Date(Date.now() + 90 * 86_400_000),
      }).where(and(eq(zakurabotDevices.id, grant.deviceId), isNull(zakurabotDevices.revokedAt))).returning();
      return device ? { device } : { error: "invalid_grant" };
    });
    if (result.device) return { credentials: await this.credentials(result.device, token, refresh) };
    return { error: result.error ?? "invalid_grant", interval: result.interval };
  }

  async refreshCredentials(refreshToken: string) {
    if (!/^zbrt_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return null;
    const current = await this.activeDevice(and(eq(zakurabotDevices.refreshTokenHash, hash(refreshToken)),
      gt(zakurabotDevices.refreshExpiresAt, new Date()))!, false);
    if (!current) return null;
    const token = `zbot_${randomBytes(32).toString("base64url")}`;
    const refresh = `zbrt_${randomBytes(32).toString("base64url")}`;
    const [device] = await this.db.update(zakurabotDevices).set({ tokenHash: hash(token),
      refreshTokenHash: hash(refresh), expiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000) })
      .where(and(eq(zakurabotDevices.id, current.id), eq(zakurabotDevices.refreshTokenHash, hash(refreshToken)),
        isNull(zakurabotDevices.revokedAt), gt(zakurabotDevices.refreshExpiresAt, new Date()))).returning();
    return device ? this.credentials(device, token, refresh) : null;
  }

  async revokeCredential(token: string) {
    if (!/^(zbot_|zbrt_)[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [device] = await this.db.update(zakurabotDevices).set({ revokedAt: new Date(), refreshTokenHash: null })
      .where(or(eq(zakurabotDevices.tokenHash, hash(token)), eq(zakurabotDevices.refreshTokenHash, hash(token)))).returning();
    return device ?? null;
  }

  async createDevice(tenantId: string, input: { name: string; bindingIds: string[]; expiresInDays: number; userId?: string }) {
    const token = `zbot_${randomBytes(32).toString("base64url")}`;
    const [device] = await this.db.insert(zakurabotDevices).values({
      tenantId, userId: input.userId, name: input.name, tokenHash: hash(token), bindingIdsJson: JSON.stringify(input.bindingIds),
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    }).returning();
    return { device: device!, token };
  }

  async getActiveUser(tenantId: string, userId: string) {
    const [row] = await this.db.select({ userId: users.id, email: users.email, role: tenantMemberships.role }).from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId)).innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"), isNull(users.suspendedAt), isNull(tenants.suspendedAt))).limit(1);
    return row ?? null;
  }

  private async activeDevice(condition: SQL, requireAccessExpiry = true): Promise<ZakurabotDevice | null> {
    const [row] = await this.db.select({ device: zakurabotDevices }).from(zakurabotDevices)
      .innerJoin(tenants, eq(tenants.id, zakurabotDevices.tenantId))
      .leftJoin(users, eq(users.id, zakurabotDevices.userId))
      .leftJoin(tenantMemberships, and(eq(tenantMemberships.userId, zakurabotDevices.userId), eq(tenantMemberships.tenantId, zakurabotDevices.tenantId)))
      .where(and(condition, isNull(zakurabotDevices.revokedAt),
        requireAccessExpiry ? gt(zakurabotDevices.expiresAt, new Date()) : undefined,
        isNull(tenants.suspendedAt), activeOwner())).limit(1);
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
