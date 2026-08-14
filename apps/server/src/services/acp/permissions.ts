/**
 * ACP 未决授权 / 表单，以及 idle reap 判定。
 */
export type PendingDecision<T> = {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
};

/** 绑定到聊天会话后，空闲超过此时长回收进程。 */
export const ACP_BOUND_IDLE_MS = 30 * 60 * 1000;

export function settleAll<T>(
  map: Map<string, PendingDecision<T>>,
  value: T,
): string[] {
  const ids = [...map.keys()];
  for (const pending of map.values()) pending.resolve(value);
  map.clear();
  return ids;
}

export function shouldReapAcpRuntime(
  live: { lastUsedAt: number; runId?: string },
  now: number,
  idleMs: number = ACP_BOUND_IDLE_MS,
): boolean {
  return !live.runId && now - live.lastUsedAt >= idleMs;
}
