/** Platform / anonymous / machine identity. Filter `user.id` or `tenant.id` = 0. */
export const PLATFORM_ACTOR_ID = "0";

export type LogActorIds = {
  userId: string;
  tenantId: string;
};

const PLATFORM_ALIASES = new Set(["", "0", "api-key", "platform", "system"]);

export function normalizeActorId(id: unknown): string {
  if (typeof id !== "string") return PLATFORM_ACTOR_ID;
  const trimmed = id.trim();
  if (PLATFORM_ALIASES.has(trimmed.toLowerCase())) return PLATFORM_ACTOR_ID;
  return trimmed.slice(0, 128);
}

export function idsFromSession(
  session?: { userId?: string | null; tenantId?: string | null } | null,
): LogActorIds {
  return {
    userId: normalizeActorId(session?.userId),
    tenantId: normalizeActorId(session?.tenantId),
  };
}

export const PLATFORM_ACTOR_IDS: LogActorIds = {
  userId: PLATFORM_ACTOR_ID,
  tenantId: PLATFORM_ACTOR_ID,
};
