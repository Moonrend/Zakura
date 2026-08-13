import { AsyncLocalStorage } from "node:async_hooks";
import {
  PLATFORM_ACTOR_IDS,
  type LogActorIds,
  normalizeActorId,
} from "./ids.js";

const storage = new AsyncLocalStorage<LogActorIds>();

export function getLogContext(): LogActorIds {
  return storage.getStore() ?? PLATFORM_ACTOR_IDS;
}

export function withLogContext<T>(ids: Partial<LogActorIds>, fn: () => T): T {
  const parent = getLogContext();
  const next: LogActorIds = {
    userId: ids.userId !== undefined ? normalizeActorId(ids.userId) : parent.userId,
    tenantId: ids.tenantId !== undefined ? normalizeActorId(ids.tenantId) : parent.tenantId,
  };
  return storage.run(next, fn);
}
