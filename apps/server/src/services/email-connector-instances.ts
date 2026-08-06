import { and, desc, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { emailConnectorInstances, newId } from "../db/schema.js";
import { createEmailProvider, type EmailProduct } from "../providers/email/index.js";

export const EMAIL_PRODUCTS: EmailProduct[] = [
  "smtp",
  "mailgun",
  "resendapi",
  "amail",
  "bettermail",
];

const secretKeys = new Set([
  "smtpPassword",
  "apiToken",
  "inboundSecret",
]);

function readConfig(secret: string, configEnc: string): Record<string, unknown> {
  try {
    return decryptJson<Record<string, unknown>>(secret, configEnc);
  } catch {
    return {};
  }
}

function stringValue(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === "string" ? config[key].trim() : "";
}

function productOf(value: unknown): EmailProduct {
  const product = String(value ?? "").trim().toLowerCase();
  if (!EMAIL_PRODUCTS.includes(product as EmailProduct)) {
    throw new Error(`邮箱 provider 必须是 ${EMAIL_PRODUCTS.join(" | ")}`);
  }
  return product as EmailProduct;
}

function validateConfig(input: Record<string, unknown>): Record<string, unknown> {
  const product = productOf(input.product);
  const config = { ...input, product };
  const requiredByProduct: Record<EmailProduct, string[]> = {
    smtp: ["smtpHost", "smtpUser", "smtpPassword", "fromEmail"],
    mailgun: ["apiToken", "mailgunDomain", "fromEmail"],
    resendapi: ["apiToken", "fromEmail"],
    amail: ["apiToken", "fromEmail"],
    bettermail: ["baseUrl", "mailbox"],
  };
  const missing = requiredByProduct[product].filter((key) => !stringValue(config, key));
  if (missing.length) throw new Error(`邮箱连接缺少必填字段: ${missing.join("、")}`);
  const normalized = createEmailProvider().validateConfig?.(config) ?? config;
  return normalized as Record<string, unknown>;
}

function view(secret: string, row: typeof emailConnectorInstances.$inferSelect) {
  const config = readConfig(secret, row.configEnc);
  const redacted = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      secretKeys.has(key) && String(value).trim() ? "***" : value,
    ]),
  );
  return {
    id: row.id,
    name: row.name,
    product: row.product as EmailProduct,
    enabled: row.enabled,
    configuredFields: Object.keys(config).filter(
      (key) => key !== "product" && config[key] != null && String(config[key]).trim() !== "",
    ),
    config: redacted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class EmailConnectorInstanceService {
  constructor(
    private readonly db: Db,
    private readonly appConfig: AppConfig,
  ) {}

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(emailConnectorInstances)
      .where(eq(emailConnectorInstances.tenantId, tenantId))
      .orderBy(desc(emailConnectorInstances.createdAt));
    return rows.map((row) => view(this.appConfig.secret, row));
  }

  async create(
    tenantId: string,
    input: { name?: string; product?: string; config?: Record<string, unknown>; enabled?: boolean },
  ) {
    const name = input.name?.trim();
    if (!name) throw new Error("邮箱连接名称不能为空");
    const config = validateConfig({ ...(input.config ?? {}), product: input.product ?? input.config?.product });
    const now = new Date();
    const [row] = await this.db
      .insert(emailConnectorInstances)
      .values({
        id: newId(),
        tenantId,
        name,
        product: String(config.product),
        enabled: input.enabled ?? false,
        configEnc: encryptJson(this.appConfig.secret, config),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return view(this.appConfig.secret, row);
  }

  async update(
    tenantId: string,
    id: string,
    input: {
      name?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    const row = await this.db.query.emailConnectorInstances.findFirst({
      where: and(eq(emailConnectorInstances.id, id), eq(emailConnectorInstances.tenantId, tenantId)),
    });
    if (!row) throw new Error("邮箱连接不存在");
    const current = readConfig(this.appConfig.secret, row.configEnc);
    for (const [key, value] of Object.entries(input.config ?? {})) {
      if (value === "***" || value === undefined) continue;
      if (value === "") delete current[key];
      else current[key] = value;
    }
    const config = validateConfig(current);
    const [updated] = await this.db
      .update(emailConnectorInstances)
      .set({
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        product: String(config.product),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        configEnc: encryptJson(this.appConfig.secret, config),
        updatedAt: new Date(),
      })
      .where(and(eq(emailConnectorInstances.id, id), eq(emailConnectorInstances.tenantId, tenantId)))
      .returning();
    return view(this.appConfig.secret, updated);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(emailConnectorInstances)
      .where(and(eq(emailConnectorInstances.id, id), eq(emailConnectorInstances.tenantId, tenantId)))
      .returning();
    return result.length > 0;
  }

  async getTargetConfig(tenantId: string) {
    const rows = await this.db
      .select()
      .from(emailConnectorInstances)
      .where(and(eq(emailConnectorInstances.tenantId, tenantId), eq(emailConnectorInstances.enabled, true)));
    return rows.map((row) => ({
      row,
      config: readConfig(this.appConfig.secret, row.configEnc),
    }));
  }

  async migrateLegacy(
    tenantId: string,
    source: string,
    config: Record<string, unknown>,
    enabled: boolean,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(emailConnectorInstances)
      .where(eq(emailConnectorInstances.tenantId, tenantId));
    if (rows.some((row) => readConfig(this.appConfig.secret, row.configEnc).legacySource === source)) {
      return;
    }
    const normalized = { ...config };
    delete normalized.legacySource;
    let validated: Record<string, unknown>;
    try {
      validated = validateConfig(normalized);
    } catch {
      return;
    }
    const now = new Date();
    await this.db.insert(emailConnectorInstances).values({
      id: newId(),
      tenantId,
      name: `${String(validated.product)}（迁移连接）`,
      product: String(validated.product),
      enabled,
      configEnc: encryptJson(this.appConfig.secret, { ...validated, legacySource: source }),
      createdAt: now,
      updatedAt: now,
    });
  }
}
