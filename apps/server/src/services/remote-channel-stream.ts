/**
 * 远程通道出站投递：用真实消息 post + edit（不用 Telegram draft 流）。
 * Draft 在工具执行等空闲间隙会被客户端清掉，表现为「发着发着消失」。
 */
import { recordPlatformFault } from "@zakura/core";
import type { CloudAgentEvent } from "@zakura/shared";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";

function eventRunId(event: {
  runId?: string | null;
  payload?: unknown;
}): string | null {
  if (typeof event.runId === "string" && event.runId) return event.runId;
  const payload = event.payload as { runId?: unknown } | undefined;
  return typeof payload?.runId === "string" && payload.runId ? payload.runId : null;
}

export function isEmptyStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /streaming requires text content/i.test(message);
}

type ThreadLike = {
  id: string;
  post: (message: unknown) => Promise<{ id: string; edit?: (content: unknown) => Promise<unknown> }>;
  startTyping?: (status?: string) => Promise<void>;
  adapter?: {
    addReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
    editMessage?: (threadId: string, messageId: string, content: unknown) => Promise<unknown>;
  };
};

/** 将某次 Run 的 assistant 文本投递到线程（post 首条，其后节流 edit）。 */
export async function deliverRunToThread(
  thread: ThreadLike,
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  opts?: { editThrottleMs?: number; typingPulseMs?: number },
): Promise<void> {
  const editThrottleMs = opts?.editThrottleMs ?? 500;
  const typingPulseMs = opts?.typingPulseMs ?? 4000;

  let accumulated = "";
  let sent: { id: string; edit?: (content: unknown) => Promise<unknown> } | null = null;
  let lastEditAt = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  const stopTypingPulse = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };

  const startTypingPulse = () => {
    if (typingTimer) return;
    void thread.startTyping?.().catch(() => undefined);
    typingTimer = setInterval(() => {
      void thread.startTyping?.().catch(() => undefined);
    }, typingPulseMs);
  };

  const flush = async (force: boolean) => {
    const text = accumulated.trimEnd();
    if (!text.trim()) return;
    const now = Date.now();
    if (!force && sent && now - lastEditAt < editThrottleMs) {
      if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          void flush(true).catch((error) => {
            recordPlatformFault("remote_agent.stream_edit", error, {
              subsystem: "remote_agent",
            });
          });
        }, editThrottleMs - (now - lastEditAt));
      }
      return;
    }
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    lastEditAt = Date.now();
    if (!sent) {
      sent = await thread.post({ markdown: text });
      return;
    }
    try {
      if (typeof sent.edit === "function") {
        const next = await sent.edit({ markdown: text });
        if (next && typeof next === "object" && "id" in (next as object)) {
          sent = next as typeof sent;
        }
      } else if (typeof thread.adapter?.editMessage === "function") {
        await thread.adapter.editMessage(thread.id, sent.id, { markdown: text });
      }
    } catch (error) {
      recordPlatformFault("remote_agent.stream_edit", error, {
        subsystem: "remote_agent",
      });
    }
  };

  startTypingPulse();
  try {
    for await (const chunk of createRunTextStream(store, sessionId, runId)) {
      accumulated += chunk;
      await flush(false);
    }
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    await flush(true);
  } finally {
    stopTypingPulse();
    if (trailing) clearTimeout(trailing);
  }
}

/**
 * 订阅 + DB 回补，把 assistant_delta 做成 AsyncIterable。
 * 仅作内部事件源；对外投递请用 deliverRunToThread。
 */
export function createRunTextStream(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const queue: string[] = [];
      const seen = new Set<string>();
      let finished = false;
      let wake: (() => void) | null = null;
      const kick = () => {
        const w = wake;
        wake = null;
        w?.();
      };

      const ingest = (event: {
        id?: string;
        type: string;
        runId?: string | null;
        payload: unknown;
      }) => {
        if (finished) return;
        const key =
          event.id ?? `${event.type}:${eventRunId(event)}:${JSON.stringify(event.payload)}`;
        if (seen.has(key)) return;
        seen.add(key);

        const rid = eventRunId(event);
        if (rid !== runId) return;

        if (event.type === "assistant_delta") {
          const delta = (event.payload as { delta?: unknown }).delta;
          if (typeof delta === "string" && delta) {
            queue.push(delta);
            kick();
          }
          return;
        }
        if (event.type === "run_error") {
          const message = (event.payload as { message?: unknown }).message;
          if (typeof message === "string" && message.trim()) {
            queue.push(message.trim());
          }
          finished = true;
          kick();
          return;
        }
        if (event.type === "run_end") {
          finished = true;
          kick();
        }
      };

      const unsub = store.subscribe(sessionId, (event: CloudAgentEvent) => {
        ingest(event);
      });

      void store
        .listEvents(sessionId, { limit: 2000 })
        .then((events) => {
          // 只回补当前 run；listEvents 从旧到新截断，长会话可能截不到最新——
          // 仍以 live subscribe 为准，这里只尽量补订阅前的竞态窗口
          for (const event of events) {
            if (eventRunId(event) === runId) ingest(event);
          }
          kick();
        })
        .catch((error) => {
          recordPlatformFault("remote_agent.stream_catchup", error, {
            subsystem: "remote_agent",
          });
          kick();
        });

      const wait = () =>
        new Promise<void>((resolve) => {
          if (queue.length > 0 || finished) {
            resolve();
            return;
          }
          wake = resolve;
        });

      return {
        async next(): Promise<IteratorResult<string>> {
          while (queue.length === 0 && !finished) await wait();
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          unsub();
          return { value: undefined as unknown as string, done: true };
        },
        async return(): Promise<IteratorResult<string>> {
          finished = true;
          unsub();
          kick();
          return { value: undefined as unknown as string, done: true };
        },
      };
    },
  };
}

/** 入站已读确认：给源消息贴 👀（平台不支持则忽略） */
export async function acknowledgeInboundMessage(
  thread: {
    id: string;
    adapter?: {
      addReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
    };
    startTyping?: (status?: string) => Promise<void>;
  },
  message: { id?: string },
): Promise<void> {
  const messageId = typeof message?.id === "string" ? message.id.trim() : "";
  if (messageId && typeof thread.adapter?.addReaction === "function") {
    try {
      await thread.adapter.addReaction(String(thread.id), messageId, "👀");
    } catch {
      /* 平台不支持表情或权限不足：对用户无影响 */
    }
  }
  if (typeof thread.startTyping === "function") {
    try {
      await thread.startTyping();
    } catch {
      // 部分平台无 typing API（如 Slack）
    }
  }
}
