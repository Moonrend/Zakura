/**
 * 把原先写在每个 Agent 上的 ACP / MCP 选择收成所属 Space 的一份。
 * 幂等：空间上已有的键不覆盖；Agent 行上的副本会删掉。
 */
import { eq } from "drizzle-orm";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, spaces } from "../db/schema.js";
import {
  parseConfigJson,
  pickSpaceAcp,
  pickSpaceMcp,
  stripSpaceOwnedKeys,
} from "./space-config.js";
import { spaceWorkspaceHostPath } from "./spaces.js";

export async function migrateAgentSettingsToSpaces(
  db: Db,
  log: (msg: string) => void,
): Promise<void> {
  let spaceRows;
  try {
    spaceRows = await db.select().from(spaces);
  } catch {
    return;
  }
  let agentRows;
  try {
    agentRows = await db.select().from(agents);
  } catch {
    return;
  }

  for (const space of spaceRows) {
    const members = agentRows.filter((agent) => agent.spaceId === space.id);
    const memberConfigs = members.map((agent) => parseConfigJson(agent.configJson));
    const spaceConfig = parseConfigJson(space.configJson);
    let spaceDirty = false;

    if (!("acp" in spaceConfig)) {
      const acp = pickSpaceAcp(memberConfigs);
      if (acp) {
        spaceConfig.acp = acp;
        spaceDirty = true;
        log(`acp → space ${space.slug}`);
      }
    }
    if (!("mcp" in spaceConfig)) {
      spaceConfig.mcp = pickSpaceMcp(memberConfigs);
      spaceDirty = true;
    }
    if (spaceDirty) {
      await db
        .update(spaces)
        .set({ configJson: JSON.stringify(spaceConfig), updatedAt: new Date() })
        .where(eq(spaces.id, space.id));
    }

    for (const agent of members) {
      const stripped = stripSpaceOwnedKeys(parseConfigJson(agent.configJson));
      if (!stripped) continue;
      await db
        .update(agents)
        .set({ configJson: JSON.stringify(stripped), updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
    }
  }
}

/** 旧模型的 Agent 级工作区目录（仍在磁盘上，只用于一次性搬迁读取）。 */
function legacyAgentWorkspacePath(config: AppConfig, agentId: string): string {
  return join(config.dataDir, "agents", agentId, "workspace");
}

function hasContent(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * 把旧 Agent 级工作区目录并入所属 Space 的工作区。
 * 幂等：目标空间已有内容则跳过；只拷贝不删除旧目录，避免误删。
 */
export async function migrateAgentWorkspacesToSpaces(
  db: Db,
  config: AppConfig,
  log: (msg: string) => void,
): Promise<void> {
  let spaceRows;
  try {
    spaceRows = await db.select().from(spaces);
  } catch {
    return;
  }
  if (!spaceRows.length) return;
  let agentRows;
  try {
    agentRows = await db.select().from(agents);
  } catch {
    return;
  }

  for (const space of spaceRows) {
    const target = spaceWorkspaceHostPath(config, space.id);
    if (hasContent(target)) continue;
    const members = agentRows
      .filter((agent) => agent.spaceId === space.id)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (!members.length) continue;

    let copied = 0;
    for (const member of members) {
      const source = legacyAgentWorkspacePath(config, member.id);
      if (!hasContent(source)) continue;
      try {
        mkdirSync(dirname(target), { recursive: true });
        // 不覆盖目标已有文件；多成员时按 updated_at 顺序合并。
        cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
        copied += 1;
      } catch (err) {
        log(
          `workspace copy failed for agent ${member.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (copied) log(`workspace → space ${space.slug} (${copied} agent dirs)`);
  }
}
