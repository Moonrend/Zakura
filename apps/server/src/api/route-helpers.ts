/**
 * routes.ts 与其拆出模块（mcp-routes / connector 路由等）共用的纯函数助手。
 *
 * 放在独立模块而非任一侧路由文件，是为了避免两个路由模块互相 import 形成循环依赖。
 * 内容自 routes.ts 原样搬迁。
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { componentInstances, managedContainers, providerCatalog } from "../db/schema.js";

export function noDcrOauthError(mcpUrl: string): string {
  const host = (() => {
    try {
      return new URL(mcpUrl).hostname;
    } catch {
      return mcpUrl;
    }
  })();
  return `${host} 不支持动态客户端注册。请填写该 MCP 自己的 OAuth Client ID/Secret。`;
}

export async function loadInstanceWithContainers(db: Db, tenantId: string, id: string) {
  const instance = await db.query.componentInstances.findFirst({
    where: and(eq(componentInstances.id, id), eq(componentInstances.tenantId, tenantId)),
  });
  if (!instance) return null;
  const [containers, provider] = await Promise.all([
    db
      .select()
      .from(managedContainers)
      .where(
        and(eq(managedContainers.instanceId, id), eq(managedContainers.tenantId, tenantId)),
      ),
    db.query.providerCatalog.findFirst({
      where: eq(providerCatalog.id, instance.providerId),
    }),
  ]);
  return { ...instance, provider: provider ?? null, containers };
}
