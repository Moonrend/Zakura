/**
 * 租户 presence：谁在哪个 Agent / 项目 / 会话。
 * Redis HASH 为跨实例真相源；REDIS_URL=off 时退回进程内 Map。
 */
import {
  PRESENCE_TTL_MS,
  isPresenceUser,
  mergePresenceByUser,
  normalizePresencePane,
  type PresenceLocation,
  type PresencePane,
} from "@zakura/shared";
import { recordPlatformFault } from "@zakura/core";
import { newId } from "../db/schema.js";
import {
  createRedisSubscriber,
  getRedis,
  REDIS_KEYS,
  type ZakuraRedis,
} from "../services/redis.js";

export type PresencePatch = {
  name?: string;
  email?: string;
  avatarRev?: number;
  agentId?: string | null;
  project?: string | null;
  sessionId?: string | null;
  pane?: PresencePane;
  idle?: boolean;
  filePath?: string | null;
  fileDir?: boolean;
};

type Fanout =
  | { kind: "update"; tenantId: string; loc: PresenceLocation }
  | { kind: "leave"; tenantId: string; userId: string };

type Stored = PresenceLocation & { socketId: string };

const local = new Map<string, Map<string, Stored>>();
const instanceId = newId();

let subClient: ZakuraRedis | null = null;
let subReady: Promise<void> | null = null;

type FanoutHandler = (msg: Fanout) => void;
const fanoutListeners = new Set<FanoutHandler>();

export function onPresenceFanout(handler: FanoutHandler): () => void {
  fanoutListeners.add(handler);
  void ensureSubscriber();
  return () => {
    fanoutListeners.delete(handler);
  };
}

function tenantMap(tenantId: string): Map<string, Stored> {
  let m = local.get(tenantId);
  if (!m) {
    m = new Map();
    local.set(tenantId, m);
  }
  return m;
}

function parseStored(raw: string, socketId: string): Stored | null {
  try {
    const v = JSON.parse(raw) as Partial<PresenceLocation>;
    if (typeof v.userId !== "string" || !v.userId) return null;
    return {
      socketId,
      userId: v.userId,
      name: typeof v.name === "string" ? v.name : v.userId,
      email: typeof v.email === "string" ? v.email : "",
      agentId: typeof v.agentId === "string" ? v.agentId : null,
      project: typeof v.project === "string" ? v.project : null,
      sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
      pane: normalizePresencePane(v.pane),
      idle: v.idle === true,
      ts: typeof v.ts === "number" ? v.ts : 0,
      avatarRev: typeof v.avatarRev === "number" ? v.avatarRev : 0,
      filePath: typeof v.filePath === "string" && v.filePath ? v.filePath : null,
      fileDir: v.fileDir === true,
    };
  } catch {
    return null;
  }
}

async function ensureSubscriber(): Promise<void> {
  if (subReady) return subReady;
  subReady = (async () => {
    try {
      if (subClient?.isOpen) return;
      const sub = await createRedisSubscriber();
      if (!sub) return;
      subClient = sub;
      await sub.pSubscribe("zakura:presence:evt:*", (message) => {
        try {
          const parsed = JSON.parse(message) as { from?: string; payload: Fanout };
          if (parsed.from === instanceId) return;
          for (const fn of fanoutListeners) fn(parsed.payload);
        } catch (err) {
          recordPlatformFault("presence.parse", err, { dep: "redis" });
        }
      });
    } catch (err) {
      recordPlatformFault("presence.subscriber", err, { dep: "redis" });
    }
  })();
  return subReady;
}

async function publish(payload: Fanout): Promise<void> {
  for (const fn of fanoutListeners) fn(payload);
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.publish(
      REDIS_KEYS.presenceChannel(payload.tenantId),
      JSON.stringify({ from: instanceId, payload }),
    );
  } catch (err) {
    recordPlatformFault("presence.publish", err, { dep: "redis" });
  }
}

export async function upsertPresence(
  tenantId: string,
  socketId: string,
  userId: string,
  patch: PresencePatch,
): Promise<PresenceLocation | null> {
  if (!isPresenceUser(userId)) return null;
  const now = Date.now();
  const prev = tenantMap(tenantId).get(socketId);
  const loc: PresenceLocation = {
    userId,
    name: patch.name ?? prev?.name ?? userId,
    email: patch.email ?? prev?.email ?? "",
    agentId: patch.agentId !== undefined ? patch.agentId : (prev?.agentId ?? null),
    project: patch.project !== undefined ? patch.project : (prev?.project ?? null),
    sessionId: patch.sessionId !== undefined ? patch.sessionId : (prev?.sessionId ?? null),
    pane: patch.pane ?? prev?.pane ?? "chat",
    idle: patch.idle ?? prev?.idle ?? false,
    ts: now,
    avatarRev: patch.avatarRev ?? prev?.avatarRev ?? 0,
    filePath: patch.filePath !== undefined ? patch.filePath : (prev?.filePath ?? null),
    fileDir: patch.fileDir ?? prev?.fileDir ?? false,
  };
  const stored: Stored = { ...loc, socketId };
  tenantMap(tenantId).set(socketId, stored);

  const redis = await getRedis();
  if (redis) {
    try {
      const key = REDIS_KEYS.presence(tenantId);
      await redis.hSet(key, socketId, JSON.stringify(loc));
      await redis.expire(key, Math.ceil((PRESENCE_TTL_MS * 3) / 1000));
    } catch (err) {
      recordPlatformFault("presence.hset", err, { dep: "redis" });
    }
  }

  await publish({ kind: "update", tenantId, loc });
  return loc;
}

export async function removePresence(
  tenantId: string,
  socketId: string,
): Promise<{ leftUserId: string | null }> {
  const prev = tenantMap(tenantId).get(socketId);
  tenantMap(tenantId).delete(socketId);
  if (tenantMap(tenantId).size === 0) local.delete(tenantId);

  const redis = await getRedis();
  if (redis) {
    try {
      await redis.hDel(REDIS_KEYS.presence(tenantId), socketId);
    } catch (err) {
      recordPlatformFault("presence.hdel", err, { dep: "redis" });
    }
  }

  if (!prev) return { leftUserId: null };
  const remaining = await snapshotPresence(tenantId);
  if (remaining.some((p) => p.userId === prev.userId)) {
    const latest = remaining.find((p) => p.userId === prev.userId);
    if (latest) await publish({ kind: "update", tenantId, loc: latest });
    return { leftUserId: null };
  }
  await publish({ kind: "leave", tenantId, userId: prev.userId });
  return { leftUserId: prev.userId };
}

export async function snapshotPresence(tenantId: string): Promise<PresenceLocation[]> {
  const now = Date.now();
  const collected: PresenceLocation[] = [];

  const redis = await getRedis();
  if (redis) {
    try {
      const all = await redis.hGetAll(REDIS_KEYS.presence(tenantId));
      const stale: string[] = [];
      for (const [socketId, raw] of Object.entries(all)) {
        const parsed = parseStored(raw, socketId);
        if (!parsed || parsed.ts + PRESENCE_TTL_MS < now) {
          stale.push(socketId);
          continue;
        }
        collected.push(parsed);
      }
      if (stale.length > 0) {
        await redis.hDel(REDIS_KEYS.presence(tenantId), stale);
      }
    } catch (err) {
      recordPlatformFault("presence.hgetall", err, { dep: "redis" });
    }
  } else {
    const m = local.get(tenantId);
    if (m) {
      for (const [socketId, row] of m) {
        if (row.ts + PRESENCE_TTL_MS < now) {
          m.delete(socketId);
          continue;
        }
        collected.push(row);
      }
    }
  }

  return mergePresenceByUser(collected, now);
}

export function parsePresencePatch(raw: unknown): PresencePatch {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string | null | undefined => {
    if (v === null) return null;
    if (typeof v === "string") return v;
    return undefined;
  };
  return {
    agentId: str(o.agentId) === undefined ? undefined : str(o.agentId),
    project: str(o.project) === undefined ? undefined : str(o.project),
    sessionId: str(o.sessionId) === undefined ? undefined : str(o.sessionId),
    pane: o.pane !== undefined ? normalizePresencePane(o.pane) : undefined,
    idle: typeof o.idle === "boolean" ? o.idle : undefined,
    filePath: str(o.filePath) === undefined ? undefined : str(o.filePath),
    fileDir: typeof o.fileDir === "boolean" ? o.fileDir : undefined,
  };
}
