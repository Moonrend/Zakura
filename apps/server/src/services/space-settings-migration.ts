/**
 * 把原先写在每个 Agent 上的 ACP / MCP 选择收成所属 Space 的一份。
 * 幂等：空间上已有的键不覆盖；Agent 行上的副本会删掉。
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, spaces } from "../db/schema.js";
import {
  parseConfigJson,
  pickSpaceAcp,
  pickSpaceMcp,
  stripSpaceOwnedKeys,
} from "./space-config.js";

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
