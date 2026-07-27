import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson, globalRegistry } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { componentInstances } from "../db/schema.js";
import type { Orchestrator } from "./orchestrator.js";

/** First-class product capabilities (each has its own settings panel). */
export type CapabilityKind = "web-search" | "web-fetch";

const META: Record<CapabilityKind, { name: string; slug: string }> = {
  "web-search": { name: "网页搜索", slug: "web-search" },
  "web-fetch": { name: "网页抓取", slug: "web-fetch" },
};

function defaultConfig(kind: CapabilityKind): Record<string, unknown> {
  if (kind === "web-search") {
    return {
      defaultEngine: "duckduckgo",
      engines: {
        duckduckgo: {
          enabled: true,
          slots: [{ id: "default", label: "默认" }],
        },
      },
    };
  }
  return {
    defaultBackend: "native",
    backends: {
      native: {
        enabled: true,
        slots: [{ id: "default", label: "默认" }],
      },
    },
  };
}

export async function ensureCapabilityInstance(
  db: Db,
  orchestrator: Orchestrator,
  tenantId: string,
  kind: CapabilityKind,
  opts?: { start?: boolean },
) {
  const shouldStart = opts?.start === true;
  const meta = META[kind];
  const existing = await db.query.componentInstances.findFirst({
    where: and(
      eq(componentInstances.tenantId, tenantId),
      eq(componentInstances.providerId, kind),
      eq(componentInstances.slug, meta.slug),
    ),
  });
  if (existing) {
    if (shouldStart && existing.status !== "running") {
      try {
        await orchestrator.startInstance(tenantId, existing.id);
      } catch {
        /* keep row; UI shows lastError */
      }
      return (
        (await db.query.componentInstances.findFirst({
          where: and(
            eq(componentInstances.id, existing.id),
            eq(componentInstances.tenantId, tenantId),
          ),
        })) ?? existing
      );
    }
    return existing;
  }

  const row = await orchestrator.createInstance({
    tenantId,
    providerId: kind,
    name: meta.name,
    slug: meta.slug,
    config: defaultConfig(kind),
  });
  if (shouldStart) {
    try {
      await orchestrator.startInstance(tenantId, row.id);
    } catch {
      /* config still saved */
    }
  }
  return (
    (await db.query.componentInstances.findFirst({
      where: and(eq(componentInstances.id, row.id), eq(componentInstances.tenantId, tenantId)),
    })) ?? row
  );
}

export function readInstanceConfig<T extends Record<string, unknown>>(
  appConfig: AppConfig,
  instance: { configEnc: string },
): T {
  return decryptJson<T>(appConfig.secret, instance.configEnc);
}

export async function saveCapabilityConfig(
  db: Db,
  orchestrator: Orchestrator,
  appConfig: AppConfig,
  tenantId: string,
  kind: CapabilityKind,
  config: Record<string, unknown>,
) {
  const instance = await ensureCapabilityInstance(db, orchestrator, tenantId, kind, {
    start: true,
  });
  const plugin = globalRegistry.get(kind);
  const normalized = plugin.validateConfig?.(config) ?? config;

  await db
    .update(componentInstances)
    .set({
      configEnc: encryptJson(appConfig.secret, normalized),
      updatedAt: new Date(),
    })
    .where(eq(componentInstances.id, instance.id));

  if (instance.status !== "running") {
    await orchestrator.startInstance(tenantId, instance.id);
  } else {
    await orchestrator.refreshHealth(tenantId, instance.id);
  }

  return db.query.componentInstances.findFirst({
    where: and(eq(componentInstances.id, instance.id), eq(componentInstances.tenantId, tenantId)),
  });
}
