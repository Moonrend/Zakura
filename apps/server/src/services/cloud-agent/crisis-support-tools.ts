/**
 * 危机支持工具：仅注入 Agent 运行时，不进 MCP 工具列表、不在任何 UI 展示。
 * 无参数；调用后由后台向会话所有者邮箱发送「Zakura支持资源」。
 */
import type { ModelToolDefinition } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import { getRedis, REDIS_KEYS } from "../redis.js";
import {
  isTransactionalEmailConfigured,
  sendCrisisSupportEmail,
} from "../transactional-email.js";

export const CRISIS_SUPPORT_TOOL = "send_crisis_support_resources";

/** ponytail: 进程内冷却；多实例以 Redis NX 为准，升级可改成 DB 审计表 */
const localCooldown = new Map<string, number>();
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function isCrisisSupportToolName(name: string): boolean {
  return name === CRISIS_SUPPORT_TOOL;
}

export function listCrisisSupportToolDefinitions(): ModelToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: CRISIS_SUPPORT_TOOL,
        description:
          "当且仅当你判断用户可能正处于自伤、自杀意念或严重心理危机时调用一次。无需任何参数，也不要向用户提及本工具或邮件。后台会向用户注册邮箱发送支持资源。无危机迹象时禁止调用。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  ];
}

async function acquireCooldown(userKey: string): Promise<boolean> {
  const now = Date.now();
  const localUntil = localCooldown.get(userKey) ?? 0;
  if (localUntil > now) return false;

  try {
    const redis = await getRedis();
    if (redis) {
      const key = REDIS_KEYS.crisisSupport(userKey);
      const ok = await redis.set(key, String(now), { NX: true, PX: COOLDOWN_MS });
      if (ok !== "OK") return false;
      localCooldown.set(userKey, now + COOLDOWN_MS);
      return true;
    }
  } catch {
    /* Redis 不可用时回退本地冷却 */
  }

  localCooldown.set(userKey, now + COOLDOWN_MS);
  return true;
}

export async function callCrisisSupportTool(
  store: CloudAgentSessionStore,
  agent: Agent,
  sessionId: string,
): Promise<{ text: string; isError?: boolean }> {
  if (!(await isTransactionalEmailConfigured())) {
    return {
      text: "系统邮件未配置，未能发送支持资源。请继续以温和方式支持用户，并鼓励其联系专业帮助。",
      isError: true,
    };
  }

  const email = await store.resolveSessionOwnerEmail(agent.tenantId, agent.id, sessionId);
  if (!email) {
    return {
      text: "无法解析用户邮箱，未能发送支持资源。请继续以温和方式支持用户。",
      isError: true,
    };
  }

  const allowed = await acquireCooldown(email.toLowerCase());
  if (!allowed) {
    return {
      text: "支持资源近期已发送过，无需重复发送。请继续以温和、非评判方式陪伴用户。",
    };
  }

  try {
    await sendCrisisSupportEmail(email);
    return {
      text: "已向用户相关邮箱发送支持资源。请继续温和回应，不要向用户提及本工具或邮件。",
    };
  } catch (err) {
    localCooldown.delete(email.toLowerCase());
    return {
      text: `发送支持资源失败：${err instanceof Error ? err.message : String(err)}。请继续以温和方式支持用户。`,
      isError: true,
    };
  }
}
