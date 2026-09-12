/** 租户内实时位置。瞬态，不落库。 */

export const PRESENCE_TTL_MS = 45_000;
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_LOCATION_THROTTLE_MS = 200;
export const POINTER_THROTTLE_MS = 80;

export type PresencePane =
  | "chat"
  | "files"
  | "tasks"
  | "projects"
  | "project-settings";

export type PresenceLocation = {
  userId: string;
  name: string;
  email: string;
  agentId: string | null;
  project: string | null;
  sessionId: string | null;
  pane: PresencePane;
  idle: boolean;
  ts: number;
  /** 自定义头像版本（毫秒时间戳）；0 表示 identicon */
  avatarRev?: number;
  /** 文件面板当前打开的路径；非 files pane 可为空 */
  filePath?: string | null;
  fileDir?: boolean;
};

export type PresencePointer = {
  /** 所在 turn 的 seq；0 表示相对整个聊天面板 */
  seq: number;
  /** 相对该 turn / 面板宽度 0..1 */
  x: number;
  /** 相对该 turn / 面板高度 0..1 */
  y: number;
};

/** 当前路径上的一个回合：哪条用户消息、哪个回答变体。 */
export type PresenceViewTurn = {
  messageId: string;
  parentKey: string;
  runId: string | null;
};

export type PresenceAwareness = {
  user: { id: string; name: string; color: string };
  caret?: { anchor: number; head: number };
  pointer?: PresencePointer | null;
  view?: PresenceViewTurn[];
};

const PANES: ReadonlySet<string> = new Set([
  "chat",
  "files",
  "tasks",
  "projects",
  "project-settings",
]);

export function isPresenceUser(userId: string | null | undefined): boolean {
  return Boolean(userId) && userId !== "api-key";
}

export function normalizePresencePane(raw: unknown): PresencePane {
  return typeof raw === "string" && PANES.has(raw) ? (raw as PresencePane) : "chat";
}

/** 同用户多连接：留最新一条；丢掉过期。 */
export function mergePresenceByUser(
  entries: PresenceLocation[],
  now = Date.now(),
): PresenceLocation[] {
  const by = new Map<string, PresenceLocation>();
  for (const e of entries) {
    if (!e.userId || e.ts + PRESENCE_TTL_MS < now) continue;
    const prev = by.get(e.userId);
    if (!prev || e.ts >= prev.ts) by.set(e.userId, e);
  }
  return [...by.values()];
}

/** 同会话在场他人。idle（隐藏页）不当幽灵头像。 */
export function othersOnSession(
  peers: PresenceLocation[],
  sessionId: string | null,
  selfId: string,
): PresenceLocation[] {
  if (!sessionId) return [];
  return peers.filter((p) => p.userId !== selfId && p.sessionId === sessionId && !p.idle);
}

/** 项目外层聚合该项目下在场他人。idle 同样排除。 */
export function othersOnProject(
  peers: PresenceLocation[],
  project: string,
  selfId: string,
): PresenceLocation[] {
  if (!project) return [];
  return peers.filter((p) => p.userId !== selfId && p.project === project && !p.idle);
}

/**
 * 有人正在工作的会话抽到前面，相对顺序保持不变。
 * idle 的不算「正在工作」。
 */
export function activeSessionIds(
  peers: PresenceLocation[],
  selfId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const p of peers) {
    if (p.userId === selfId || p.idle || !p.sessionId) continue;
    ids.add(p.sessionId);
  }
  return ids;
}

export function splitActiveSessions<T extends { id: string }>(
  sessions: T[],
  activeIds: Iterable<string>,
): { active: T[]; rest: T[] } {
  const ids = new Set(activeIds);
  const active: T[] = [];
  const rest: T[] = [];
  const placed = new Set<string>();
  for (const s of sessions) {
    if (ids.has(s.id) && !placed.has(s.id)) {
      active.push(s);
      placed.add(s.id);
    }
  }
  for (const s of sessions) {
    if (!ids.has(s.id)) rest.push(s);
  }
  return { active, rest };
}

export type PresenceTurnPage = {
  seq: number;
  messageId: string;
  parentKey: string;
  runId: string | null;
  siblings: string[];
  variants: string[];
};

/** 对方在该回合选了另一条兄弟消息（编辑/重发分叉）。 */
export function remoteOnOtherSibling(
  view: PresenceViewTurn[] | undefined,
  turn: Pick<PresenceTurnPage, "messageId" | "parentKey" | "siblings">,
): boolean {
  if (!view || turn.siblings.length <= 1) return false;
  const hit = view.find((v) => v.parentKey === turn.parentKey);
  return Boolean(hit && hit.messageId !== turn.messageId && turn.siblings.includes(hit.messageId));
}

/** 对方在该回合选了另一个回答变体（重新生成）。 */
export function remoteOnOtherVariant(
  view: PresenceViewTurn[] | undefined,
  turn: Pick<PresenceTurnPage, "messageId" | "runId" | "variants">,
): boolean {
  if (!view || turn.variants.length <= 1) return false;
  const hit = view.find((v) => v.messageId === turn.messageId);
  if (!hit?.runId || hit.runId === turn.runId) return false;
  return turn.variants.includes(hit.runId);
}

/** 光标落在对方正在看、但本地没打开的那一页时藏掉。 */
export function pointerHiddenForView(
  remote: { pointer?: PresencePointer | null; view?: PresenceViewTurn[] },
  displayed: PresenceTurnPage[],
): boolean {
  const ptr = remote.pointer;
  if (!ptr) return true;
  if (ptr.seq <= 0) {
    return displayed.some(
      (t) => remoteOnOtherSibling(remote.view, t) || remoteOnOtherVariant(remote.view, t),
    );
  }
  const turn = displayed.find((t) => t.seq === ptr.seq);
  if (!turn) return true;
  return remoteOnOtherSibling(remote.view, turn) || remoteOnOtherVariant(remote.view, turn);
}
