/**
 * 会话草稿 Yjs 中继：一份 Y.Doc / 会话，Socket.IO 差量同步，Redis 热快照，
 * debounce 写回 cloud_agent_sessions.draft_text。
 */
import * as Y from "yjs";
import { recordPlatformFault } from "@zakura/core";
import { newId } from "../db/schema.js";
import {
  createRedisSubscriber,
  getRedis,
  REDIS_KEYS,
  type ZakuraRedis,
} from "../services/redis.js";

const PERSIST_MS = 800;
const DOC_IDLE_MS = 5 * 60_000;
const instanceId = newId();

export type YjsStore = {
  getSession: (
    tenantId: string,
    agentId: string,
    sessionId: string,
  ) => Promise<{ id: string; draftText?: string } | null>;
  updateSession?: (
    tenantId: string,
    agentId: string,
    sessionId: string,
    patch: { draftText?: string },
  ) => Promise<unknown>;
};

type DocEntry = {
  doc: Y.Doc;
  tenantId: string;
  agentId: string;
  refs: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const docs = new Map<string, DocEntry>();

type UpdateHandler = (sessionId: string, update: Uint8Array, fromSocketId: string) => void;
type AwarenessHandler = (sessionId: string, update: Uint8Array, fromSocketId: string) => void;

const updateListeners = new Set<UpdateHandler>();
const awarenessListeners = new Set<AwarenessHandler>();

let subClient: ZakuraRedis | null = null;
let subReady: Promise<void> | null = null;

export function onYjsUpdate(handler: UpdateHandler): () => void {
  updateListeners.add(handler);
  void ensureSubscriber();
  return () => updateListeners.delete(handler);
}

export function onYjsAwareness(handler: AwarenessHandler): () => void {
  awarenessListeners.add(handler);
  return () => awarenessListeners.delete(handler);
}

function b64ToU8(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

function u8ToB64(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64");
}

async function ensureSubscriber(): Promise<void> {
  if (subReady) return subReady;
  subReady = (async () => {
    try {
      if (subClient?.isOpen) return;
      const sub = await createRedisSubscriber();
      if (!sub) return;
      subClient = sub;
      await sub.pSubscribe("zakura:sync:evt:*", (message) => {
        try {
          const parsed = JSON.parse(message) as {
            from?: string;
            sessionId: string;
            kind: "update" | "awareness";
            update: string;
            socketId: string;
          };
          if (parsed.from === instanceId) return;
          const bytes = b64ToU8(parsed.update);
          if (parsed.kind === "awareness") {
            for (const fn of awarenessListeners) fn(parsed.sessionId, bytes, parsed.socketId);
            return;
          }
          const entry = docs.get(parsed.sessionId);
          if (entry) Y.applyUpdate(entry.doc, bytes, "remote");
          for (const fn of updateListeners) fn(parsed.sessionId, bytes, parsed.socketId);
        } catch (err) {
          recordPlatformFault("yjs.parse", err, { subsystem: "sync" });
        }
      });
    } catch (err) {
      recordPlatformFault("yjs.subscriber", err, { dep: "redis" });
    }
  })();
  return subReady;
}

async function publish(
  sessionId: string,
  kind: "update" | "awareness",
  update: Uint8Array,
  socketId: string,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.publish(
      REDIS_KEYS.syncChannel(sessionId),
      JSON.stringify({
        from: instanceId,
        sessionId,
        kind,
        update: u8ToB64(update),
        socketId,
      }),
    );
  } catch (err) {
    recordPlatformFault("yjs.publish", err, { dep: "redis" });
  }
}

function schedulePersist(entry: DocEntry, sessionId: string, store: YjsStore): void {
  if (entry.persistTimer) clearTimeout(entry.persistTimer);
  entry.persistTimer = setTimeout(() => {
    entry.persistTimer = null;
    const text = entry.doc.getText("draft").toString();
    void store.updateSession?.(entry.tenantId, entry.agentId, sessionId, { draftText: text }).catch(
      (err) => recordPlatformFault("yjs.persist", err, { subsystem: "sync" }),
    );
    void snapshotToRedis(sessionId, entry.doc);
  }, PERSIST_MS);
}

function bumpIdle(sessionId: string, entry: DocEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.refs > 0) return;
    try {
      entry.doc.destroy();
    } catch {
      /* ignore */
    }
    docs.delete(sessionId);
  }, DOC_IDLE_MS);
}

async function snapshotToRedis(sessionId: string, doc: Y.Doc): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(REDIS_KEYS.syncDoc(sessionId), u8ToB64(Y.encodeStateAsUpdate(doc)), {
      EX: 24 * 3600,
    });
  } catch (err) {
    recordPlatformFault("yjs.snapshot", err, { dep: "redis" });
  }
}

async function loadDoc(
  tenantId: string,
  agentId: string,
  sessionId: string,
  store: YjsStore,
): Promise<DocEntry | null> {
  const existing = docs.get(sessionId);
  if (existing) return existing;

  const row = await store.getSession(tenantId, agentId, sessionId);
  if (!row) return null;

  const doc = new Y.Doc();
  const redis = await getRedis();
  let seeded = false;
  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEYS.syncDoc(sessionId));
      if (raw) {
        Y.applyUpdate(doc, b64ToU8(raw));
        seeded = doc.getText("draft").length > 0;
      }
    } catch (err) {
      recordPlatformFault("yjs.load", err, { dep: "redis" });
    }
  }
  if (!seeded) {
    const draft = row.draftText ?? "";
    if (draft) doc.getText("draft").insert(0, draft);
  }

  const entry: DocEntry = {
    doc,
    tenantId,
    agentId,
    refs: 0,
    persistTimer: null,
    idleTimer: null,
  };
  docs.set(sessionId, entry);
  return entry;
}

/** 相对客户端 state vector 编码差量；sv 缺失/损坏时回退全量。 */
function encodeDiff(
  doc: Y.Doc,
  stateVector?: Uint8Array | null,
): { update: Uint8Array; sv: Uint8Array } {
  let update: Uint8Array;
  try {
    update =
      stateVector && stateVector.byteLength > 0
        ? Y.encodeStateAsUpdate(doc, stateVector)
        : Y.encodeStateAsUpdate(doc);
  } catch {
    update = Y.encodeStateAsUpdate(doc);
  }
  return { update, sv: Y.encodeStateVector(doc) };
}

export async function subscribeYjs(
  tenantId: string,
  agentId: string,
  sessionId: string,
  store: YjsStore,
  stateVector?: Uint8Array | null,
): Promise<{ ok: true; update: Uint8Array; sv: Uint8Array } | { ok: false; error: string }> {
  const entry = await loadDoc(tenantId, agentId, sessionId, store);
  if (!entry) return { ok: false, error: "Not found" };
  entry.refs += 1;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  void ensureSubscriber();
  const diff = encodeDiff(entry.doc, stateVector);
  return { ok: true, ...diff };
}

/** 已订阅时只取差量，不增加 refs（重连 / 重复 sync:sub）。 */
export function yjsDiffAgainst(
  sessionId: string,
  stateVector?: Uint8Array | null,
): { update: Uint8Array; sv: Uint8Array } | null {
  const entry = docs.get(sessionId);
  if (!entry) return null;
  return encodeDiff(entry.doc, stateVector);
}

export function unsubscribeYjs(sessionId: string, store: YjsStore): void {
  const entry = docs.get(sessionId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) {
    schedulePersist(entry, sessionId, store);
    bumpIdle(sessionId, entry);
  }
}

export function applyYjsUpdate(
  sessionId: string,
  update: Uint8Array,
  fromSocketId: string,
  store: YjsStore,
): boolean {
  const entry = docs.get(sessionId);
  if (!entry) return false;
  Y.applyUpdate(entry.doc, update, fromSocketId);
  schedulePersist(entry, sessionId, store);
  for (const fn of updateListeners) fn(sessionId, update, fromSocketId);
  void publish(sessionId, "update", update, fromSocketId);
  return true;
}

export function relayYjsAwareness(
  sessionId: string,
  update: Uint8Array,
  fromSocketId: string,
): void {
  if (!docs.has(sessionId)) return;
  for (const fn of awarenessListeners) fn(sessionId, update, fromSocketId);
  void publish(sessionId, "awareness", update, fromSocketId);
}

export function encodeYjsUpdate(bytes: Uint8Array): string {
  return u8ToB64(bytes);
}

export function decodeYjsUpdate(raw: unknown): Uint8Array | null {
  if (typeof raw === "string" && raw) {
    try {
      return b64ToU8(raw);
    } catch {
      return null;
    }
  }
  if (raw instanceof Uint8Array) return raw;
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
  if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
    return Uint8Array.from(raw);
  }
  return null;
}
