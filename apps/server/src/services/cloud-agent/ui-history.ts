/**
 * UI 会话历史窗口裁剪（纯函数，供 listEventsForUi 与回归测试共用）。
 *
 * listEvents 默认 500 尾窗在工具/delta 密集时可能不含 user_message，
 * 导致 buildConversationTurns 得到空 turns → 聊天页空白欢迎屏。
 */
import type { CloudAgentEvent } from "@zakura/shared";

export function sliceEventsPreferringUserMessage<T extends { type: string }>(
  events: T[],
  maxEvents: number,
): T[] {
  if (events.length <= maxEvents) return events;
  const sliced = events.slice(-maxEvents);
  if (sliced.some((e) => e.type === "user_message")) return sliced;
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "user_message") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx >= 0 ? events.slice(lastUserIdx) : sliced;
}

/**
 * 尾窗截断后，parentRunId 指向未加载 run 的 user_message 提升为根，
 * 否则从 parentKey="" 起步会得到空 turns。
 */
export function reattachOrphanUserRoots<
  T extends { id: string; parentKey: string; seq: number },
>(userMsgs: Map<string, T>, knownParentKeys: Iterable<string>): void {
  const known = new Set<string>(knownParentKeys);
  known.add("");
  const hasRoot = [...userMsgs.values()].some((n) => n.parentKey === "");
  if (hasRoot || userMsgs.size === 0) return;

  for (const node of userMsgs.values()) {
    if (known.has(node.parentKey)) continue;
    node.parentKey = "";
  }
}

const TOOL_EVENT_TYPES = new Set([
  "tool_call_start",
  "tool_call_args",
  "tool_call_result",
]);

/** 不打断工具 burst 的间隙事件（状态点、shell 日志） */
const TOOL_BURST_SKIP = new Set(["run_status", "tool_call_progress"]);

/**
 * UI 历史瘦身：每个工具 burst（连续工具调用，被正文/思考隔开）只保留前 keepFullPerBurst
 * 个工具的完整 args/result；其余只留 start + 元数据 result（detailPending），展开再拉。
 */
export function slimToolEventsForUi(
  events: CloudAgentEvent[],
  opts?: { keepFullPerBurst?: number; maxResultChars?: number },
): CloudAgentEvent[] {
  const keepFullPerBurst = Math.min(Math.max(opts?.keepFullPerBurst ?? 1, 0), 20);
  const maxResultChars = Math.min(Math.max(opts?.maxResultChars ?? 2_000, 200), 12_000);

  const keep = new Map<string, boolean>();
  let fullLeft = keepFullPerBurst;
  let inBurst = false;

  const out: CloudAgentEvent[] = [];
  for (const ev of events) {
    if (TOOL_EVENT_TYPES.has(ev.type)) {
      inBurst = true;
      const p = ev.payload as Record<string, unknown>;
      const id = typeof p.toolCallId === "string" ? p.toolCallId : "";

      if (ev.type === "tool_call_start") {
        if (id && !keep.has(id)) {
          keep.set(id, fullLeft > 0);
          if (fullLeft > 0) fullLeft -= 1;
        }
        out.push(ev);
        continue;
      }
      if (ev.type === "tool_call_args") {
        if (id && keep.get(id)) out.push(ev);
        continue;
      }
      // tool_call_result
      if (id) {
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (
            e.type === "tool_call_progress" &&
            (e.payload as { toolCallId?: string }).toolCallId === id
          ) {
            out.splice(i, 1);
          }
        }
      }
      if (!id) {
        out.push(ev);
        continue;
      }
      if (keep.get(id)) {
        const resultText = typeof p.resultText === "string" ? p.resultText : "";
        if (resultText.length <= maxResultChars) {
          out.push(ev);
        } else {
          out.push({
            ...ev,
            payload: {
              ...p,
              resultText: resultText.slice(0, maxResultChars),
              detailPending: true,
            } as CloudAgentEvent["payload"],
          });
        }
        continue;
      }
      out.push({
        ...ev,
        payload: {
          toolCallId: id,
          name: typeof p.name === "string" ? p.name : "tool",
          isError: p.isError === true,
          durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
          resultText: "",
          detailPending: true,
          ...(typeof p.childSessionId === "string"
            ? { childSessionId: p.childSessionId }
            : {}),
          ...(typeof p.childAgentId === "string" ? { childAgentId: p.childAgentId } : {}),
        } as CloudAgentEvent["payload"],
      });
      continue;
    }

    if (TOOL_BURST_SKIP.has(ev.type)) {
      if (ev.type === "tool_call_progress") {
        const p = ev.payload as Record<string, unknown>;
        const id = typeof p.toolCallId === "string" ? p.toolCallId : "";
        if (!id) continue;
        const idx = out.findIndex(
          (e) =>
            e.type === "tool_call_progress" &&
            (e.payload as { toolCallId?: string }).toolCallId === id,
        );
        if (idx >= 0) out[idx] = ev;
        else out.push(ev);
        continue;
      }
      out.push(ev);
      continue;
    }

    if (inBurst) {
      inBurst = false;
      fullLeft = keepFullPerBurst;
    }
    out.push(ev);
  }
  return out;
}
