import { and, asc, eq } from "drizzle-orm";
import { encryptJson } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { newId, upstreamOauthClients } from "../db/schema.js";

function hostOf(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).hostname.replace(/^www\./, "") || "unknown";
  } catch {
    return "unknown";
  }
}

export type UpstreamOauthClientSource = "dcr" | "byo";

export class UpstreamOauthClientStore {
  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
  ) {}

  /** 记录或更新：本地向远程注册（DCR）或用户自备（BYO） */
  async record(input: {
    tenantId: string;
    mcpUrl: string;
    clientId: string;
    clientSecret?: string;
    clientName?: string;
    source: UpstreamOauthClientSource;
    registrationEndpoint?: string | null;
    scope?: string;
    instanceId?: string | null;
  }) {
    const clientId = input.clientId.trim();
    if (!clientId) return null;
    const mcpUrl = input.mcpUrl.trim();
    const host = hostOf(mcpUrl);
    const now = new Date();
    const secretEnc =
      input.clientSecret && input.clientSecret.trim()
        ? encryptJson(this.appConfig.secret, { clientSecret: input.clientSecret.trim() })
        : null;

    const existing = await this.db.query.upstreamOauthClients.findFirst({
      where: and(
        eq(upstreamOauthClients.tenantId, input.tenantId),
        eq(upstreamOauthClients.host, host),
        eq(upstreamOauthClients.clientId, clientId),
      ),
    });

    if (existing) {
      const [row] = await this.db
        .update(upstreamOauthClients)
        .set({
          mcpUrl,
          clientName: input.clientName?.trim() || existing.clientName,
          source: input.source,
          ...(secretEnc ? { secretEnc } : {}),
          registrationEndpoint:
            input.registrationEndpoint?.trim() || existing.registrationEndpoint,
          scope: input.scope?.trim() || existing.scope,
          instanceId: input.instanceId ?? existing.instanceId,
          updatedAt: now,
        })
        .where(eq(upstreamOauthClients.id, existing.id))
        .returning();
      return row ?? existing;
    }

    const [row] = await this.db
      .insert(upstreamOauthClients)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        mcpUrl,
        host,
        clientId,
        secretEnc,
        clientName: input.clientName?.trim() || "",
        source: input.source,
        registrationEndpoint: input.registrationEndpoint?.trim() || null,
        scope: input.scope?.trim() || "",
        instanceId: input.instanceId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row ?? null;
  }

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(upstreamOauthClients)
      .where(eq(upstreamOauthClients.tenantId, tenantId))
      .orderBy(asc(upstreamOauthClients.createdAt));
    return rows.map((r) => ({
      id: r.id,
      mcpUrl: r.mcpUrl,
      host: r.host,
      clientId: r.clientId,
      clientName: r.clientName,
      source: r.source as UpstreamOauthClientSource,
      hasSecret: !!r.secretEnc,
      registrationEndpoint: r.registrationEndpoint,
      scope: r.scope,
      instanceId: r.instanceId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}
