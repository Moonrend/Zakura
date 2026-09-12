/**
 * 远程通道出站：等待 Agent Run 结束，并维持 typing。
 * 用户可见回复由 chat_reply 等工具发出，不镜像 assistant 文本。
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

type ThreadLike = {
  id: string;
  post: (message: unknown) => Promise<unknown>;
  startTyping?: (status?: string) => Promise<void>;
  adapter?: {
    addReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
  };
};

export async function waitForRemoteRun(
  thread: ThreadLike,
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  opts?: { typingPulseMs?: number },
): Promise<void> {
  const typingPulseMs = opts?.typingPulseMs ?? 4000;
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

  startTypingPulse();
  try {
    const outcome = await waitForRunEnd(store, sessionId, runId);
    if (outcome.status === "error" && outcome.message) {
      await thread.post({ markdown: `Agent 暂时无法处理消息：${outcome.message}` }).catch((error) => {
        recordPlatformFault("remote_agent.run_error_post", error, {
          subsystem: "remote_agent",
        });
      });
    }
  } finally {
    stopTypingPulse();
  }
}

function waitForRunEnd(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
): Promise<{ status: "completed" | "error" | "cancelled"; message?: string }> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: { status: "completed" | "error" | "cancelled"; message?: string }) => {
      if (finished) return;
      finished = true;
      unsub();
      resolve(result);
    };

    const ingest = (event: {
      type: string;
      runId?: string | null;
      payload: unknown;
    }) => {
      if (finished) return;
      if (eventRunId(event) !== runId) return;
      if (event.type === "run_error") {
        const message = (event.payload as { message?: unknown }).message;
        finish({
          status: "error",
          message: typeof message === "string" && message.trim() ? message.trim() : undefined,
        });
        return;
      }
      if (event.type === "run_end") {
        const status = (event.payload as { status?: unknown }).status;
        finish({
          status: status === "cancelled" ? "cancelled" : status === "error" || status === "failed" ? "error" : "completed",
          message:
            typeof (event.payload as { message?: unknown }).message === "string"
              ? String((event.payload as { message: string }).message)
              : undefined,
        });
      }
    };

    const unsub = store.subscribe(sessionId, (event: CloudAgentEvent) => {
      ingest(event);
    });

    void store
      .listEvents(sessionId, { limit: 2000 })
      .then((events) => {
        for (const event of events) {
          if (eventRunId(event) === runId) ingest(event);
        }
      })
      .catch((error) => {
        recordPlatformFault("remote_agent.run_wait_catchup", error, {
          subsystem: "remote_agent",
        });
      });
  });
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
