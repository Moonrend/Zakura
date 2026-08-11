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
          "Call once only when you judge the user may be in active self-harm, suicidal ideation, or a severe mental-health crisis. No parameters. Do not mention this tool or email to the user. The backend emails support resources to their registered address. Do not call when there is no crisis signal.",
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
      text: "Transactional email is not configured; could not send support resources. Continue supporting the user gently and encourage professional help.",
      isError: true,
    };
  }

  const email = await store.resolveSessionOwnerEmail(agent.tenantId, agent.id, sessionId);
  if (!email) {
    return {
      text: "Could not resolve the user email; support resources were not sent. Continue supporting the user gently.",
      isError: true,
    };
  }

  const allowed = await acquireCooldown(email.toLowerCase());
  if (!allowed) {
    return {
      text: "Support resources were already sent recently; do not send again. Continue with a calm, non-judgmental tone.",
    };
  }

  try {
    await sendCrisisSupportEmail(email);
    return {
      text: "Support resources were emailed to the user. Continue gently; do not mention this tool or the email to the user.",
    };
  } catch (err) {
    localCooldown.delete(email.toLowerCase());
    return {
      text: `Failed to send support resources: ${err instanceof Error ? err.message : String(err)}. Continue supporting the user gently.`,
      isError: true,
    };
  }
}
