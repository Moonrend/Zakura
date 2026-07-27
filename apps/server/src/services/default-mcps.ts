import { and, eq } from "drizzle-orm";
import { decryptJson } from "@zakura/core";
import { DEFAULT_AGENT_AUTO_INSTALL_MCPS } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agentBindings, componentInstances, newId } from "../db/schema.js";
import { normalizeMcpHttpUrl } from "../lib/mcp-http.js";
import type { Orchestrator } from "./orchestrator.js";

function normUrl(url: string): string {
  return normalizeMcpHttpUrl(url).replace(/\/$/, "").toLowerCase();
}

/**
 * 确保租户已安装「新建 Agent 默认绑定」的无鉴权 HTTP MCP（如 Grep）。
 * 已存在则复用并尽量保持 running；失败不抛，由调用方决定是否绑定。
 * @returns 可绑定的 instanceId 列表
 */
export async function ensureDefaultAgentMcps(
  db: Db,
  orchestrator: Orchestrator,
  appConfig: AppConfig,
  tenantId: string,
): Promise<string[]> {
  const instanceIds: string[] = [];

  for (const mcp of DEFAULT_AGENT_AUTO_INSTALL_MCPS) {
    if (mcp.kind !== "http" || !mcp.mcpUrl?.trim()) continue;

    try {
      const targetUrl = normUrl(mcp.mcpUrl);
      const existing = await db
        .select()
        .from(componentInstances)
        .where(
          and(
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.providerId, "generic-mcp"),
          ),
        );

      let row =
        existing.find((i) => {
          const ep = (i.endpointUrl ?? "").replace(/\/$/, "").toLowerCase();
          if (ep && ep === targetUrl) return true;
          if (i.slug === mcp.id) return true;
          return false;
        }) ?? null;

      if (!row) {
        for (const i of existing) {
          try {
            const cfg = decryptJson<{ mcpUrl?: string }>(appConfig.secret, i.configEnc);
            if (cfg.mcpUrl && normUrl(cfg.mcpUrl) === targetUrl) {
              row = i;
              break;
            }
          } catch {
            /* ignore corrupt config */
          }
        }
      }

      if (!row) {
        const slugBase = mcp.id.slice(0, 32) || `mcp-${Date.now().toString(36)}`;
        let slug = slugBase;
        for (let n = 0; n < 20; n++) {
          const candidate = n === 0 ? slugBase : `${slugBase.slice(0, 28)}-${n + 1}`;
          const clash = await db.query.componentInstances.findFirst({
            where: and(
              eq(componentInstances.tenantId, tenantId),
              eq(componentInstances.slug, candidate),
            ),
          });
          if (!clash) {
            slug = candidate;
            break;
          }
        }

        row = await orchestrator.createInstance({
          tenantId,
          providerId: "generic-mcp",
          name: mcp.name,
          slug,
          config: {
            mcpUrl: normalizeMcpHttpUrl(mcp.mcpUrl),
            apiKey: "",
            headerName: "Authorization",
          },
        });
      }

      if (row.status !== "running") {
        try {
          await orchestrator.startInstance(tenantId, row.id);
        } catch (err) {
          console.warn(
            `[default-mcps] start ${mcp.id} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      instanceIds.push(row.id);
    } catch (err) {
      console.warn(
        `[default-mcps] ensure ${mcp.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return instanceIds;
}

/** 将默认 MCP 绑定到 Agent（幂等） */
export async function bindDefaultMcpsToAgent(
  db: Db,
  tenantId: string,
  agentId: string,
  instanceIds: string[],
): Promise<void> {
  const now = new Date();
  for (const instanceId of instanceIds) {
    try {
      await db
        .insert(agentBindings)
        .values({
          id: newId(),
          tenantId,
          agentId,
          instanceId,
          createdAt: now,
        })
        .onConflictDoNothing();
    } catch (err) {
      console.warn(
        `[default-mcps] bind ${instanceId} -> ${agentId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
