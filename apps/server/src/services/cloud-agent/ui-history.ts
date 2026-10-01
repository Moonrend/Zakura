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
 * 标签级参数裁剪：给 detailPending 的折叠行保留一份可解析的参数摘要。
 * 直接 slice 原始 JSON 会截坏语法，前端 tryParseArgs 会退化为空标签；
 * 这里保持 JSON 合法，只截断超长字符串与过大数组，仍超预算时丢弃体积最大的字段，
 * 短小的标签字段（command / path / query / task / url…）天然保留。
 */
export function slimToolArgsForUi(
  raw: string,
  opts?: { maxValueChars?: number; maxItems?: number; maxTotalChars?: number },
): string {
  const maxValueChars = Math.min(Math.max(opts?.maxValueChars ?? 160, 20), 4000);
  const maxItems = Math.min(Math.max(opts?.maxItems ?? 16, 1), 200);
  const maxTotalChars = Math.min(Math.max(opts?.maxTotalChars ?? 800, 120), 6000);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > maxTotalChars ? `${raw.slice(0, maxTotalChars)}…` : raw;
  }

  const clamp = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.length > maxValueChars ? `${v.slice(0, maxValueChars)}…` : v;
    }
    if (Array.isArray(v)) {
      const shown = v.slice(0, maxItems).map(clamp);
      return v.length > maxItems ? [...shown, `…(+${v.length - maxItems})`] : shown;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = clamp(val);
      }
      return out;
    }
    return v;
  };

  const slimmed = clamp(parsed);
  let out = JSON.stringify(slimmed);
  if (
    out.length <= maxTotalChars ||
    !slimmed ||
    typeof slimmed !== "object" ||
    Array.isArray(slimmed)
  ) {
    return out;
  }
  // 字段过多仍超预算：按序列化体积从大到小丢弃
  const sizeOf = (v: unknown): number => JSON.stringify(v ?? null)?.length ?? 0;
  const entries = Object.entries(slimmed as Record<string, unknown>).sort(
    (a, b) => sizeOf(b[1]) - sizeOf(a[1]),
  );
  while (out.length > maxTotalChars && entries.length > 1) {
    entries.splice(0, 1);
    out = JSON.stringify(Object.fromEntries(entries));
  }
  return out;
}

/**
 * UI 历史瘦身：每个工具 burst（连续工具调用，被正文/思考隔开）只保留前 keepFullPerBurst
 * 个工具的完整 args/result；其余保留 start + 参数摘要 + 元数据 result（detailPending），
 * 折叠行标签可直接渲染，完整内容展开再拉。
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
        if (id && keep.get(id)) {
          out.push(ev);
          continue;
        }
        // 折叠行也要能直接渲染标签（命令/路径/查询词…）：保留合法 JSON 的参数摘要
        if (id && typeof p.arguments === "string" && p.arguments) {
          out.push({
            ...ev,
            payload: {
              toolCallId: id,
              arguments: slimToolArgsForUi(p.arguments),
            } as CloudAgentEvent["payload"],
          });
        }
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
