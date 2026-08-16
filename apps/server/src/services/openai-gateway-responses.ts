/**
 * OpenAI Responses API（/v1/responses）到内部 chat 路由的桥接。
 *
 * Codex ≥1.2 移除了 `wire_api = "chat"`，只说 Responses 协议；Zakura 网关
 * 的上游是 OpenAI 兼容 chat completions。这里把 Responses 请求翻译成
 * chat 请求复用 prepare/invoke，再把流式增量翻译回 Responses SSE 事件。
 * 桥接无状态：Codex 默认 store=false，每轮都回传完整 input 历史。
 */
import type { OpenAiGatewayBody } from "./openai-gateway.js";

type RawRecord = Record<string, unknown>;

function asRecord(raw: unknown): RawRecord | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawRecord) : null;
}

/** Responses 的 content parts → chat content（字符串或多段数组）。 */
function responsesContentToChat(content: unknown): string | Array<RawRecord> | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: Array<RawRecord> = [];
  let plain = "";
  for (const item of content) {
    const part = asRecord(item);
    if (!part) continue;
    if (typeof part.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === "summary_text")) {
      plain += part.text;
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "input_image") {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : typeof (asRecord(part.image_url) ?? {}).url === "string"
            ? (asRecord(part.image_url) as RawRecord).url
            : undefined;
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    // refusal 等罕见 part：丢弃，保持 chat 兼容。
  }
  if (parts.length === 0) return plain || null;
  const allText = parts.every((p) => p.type === "text");
  return allText ? plain : parts;
}

/**
 * Responses `input` → chat `messages`。
 * - message（user/assistant/system/developer）
 * - function_call / function_call_output（Codex 的工具回合）
 * - reasoning（Codex 回传的思考项；chat 桥接用不上，跳过）
 */
export function responsesInputToMessages(input: unknown): Array<RawRecord> {
  const messages: Array<RawRecord> = [];
  if (typeof input === "string") {
    return input.trim() ? [{ role: "user", content: input }] : [];
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    const record = asRecord(item);
    if (!record) continue;
    const type = typeof record.type === "string" ? record.type : "message";
    if (type === "message") {
      const role =
        record.role === "user" || record.role === "assistant" || record.role === "system" || record.role === "developer"
          ? record.role
          : "user";
      const content = responsesContentToChat(record.content);
      messages.push({ role, ...(content !== null ? { content } : { content: "" }) });
      continue;
    }
    if (type === "function_call") {
      // assistant 发起的工具调用：转成带 tool_calls 的 assistant 消息。
      const name = typeof record.name === "string" ? record.name : "";
      const callId = typeof record.call_id === "string" ? record.call_id : `call_${messages.length}`;
      const args = typeof record.arguments === "string" ? record.arguments : "{}";
      messages.push({
        role: "assistant",
        content: typeof record.content === "string" ? record.content : "",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name, arguments: args },
          },
        ],
      });
      continue;
    }
    if (type === "function_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      const output = record.output;
      const content =
        typeof output === "string" ? output : JSON.stringify(output ?? "");
      messages.push({ role: "tool", tool_call_id: callId, content });
      continue;
    }
    // reasoning / item_reference / local_shell_call 等：chat 桥接无法表达，跳过。
  }
  return messages;
}

/** Responses tools（扁平 function 定义）→ chat tools（嵌套 function 节点）。 */
function responsesToolsToChat(tools: unknown): Array<RawRecord> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<RawRecord> = [];
  for (const item of tools) {
    const record = asRecord(item);
    if (!record || record.type !== "function") continue;
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    out.push({
      type: "function",
      function: {
        name: record.name.trim().slice(0, 64),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        parameters:
          record.parameters && typeof record.parameters === "object"
            ? record.parameters
            : { type: "object", properties: {} },
        ...(record.strict === true ? { strict: true } : {}),
      },
    });
  }
  return out.length ? out : undefined;
}

function responsesToolChoiceToChat(raw: unknown): unknown {
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  const record = asRecord(raw);
  if (record && record.type === "function" && typeof record.name === "string") {
    return { type: "function", function: { name: record.name } };
  }
  return undefined;
}

/** 把 /v1/responses 请求体翻译成网关内部的 chat completions 请求体。 */
export function translateResponsesRequest(raw: unknown): OpenAiGatewayBody {
  const body = asRecord(raw) ?? {};
  const messages: Array<RawRecord> = [];
  const instructions =
    typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions
      : undefined;
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responsesInputToMessages(body.input));

  const reasoning = asRecord(body.reasoning);
  const tools = responsesToolsToChat(body.tools);

  const translated: OpenAiGatewayBody = {
    messages,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(body.stream === true ? { stream: true } : {}),
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined
      ? { tool_choice: responsesToolChoiceToChat(body.tool_choice) }
      : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof body.max_output_tokens === "number" ? { max_tokens: body.max_output_tokens } : {}),
    ...(reasoning && typeof reasoning.effort === "string"
      ? { reasoning_effort: reasoning.effort }
      : {}),
  };
  return translated;
}

// —— SSE 事件组装 ————————————————————————————————————————————

export type ResponsesEvent = RawRecord & { type: string };

let eventSeq = 0;
function nextSeq(): number {
  eventSeq = (eventSeq + 1) % Number.MAX_SAFE_INTEGER;
  return eventSeq;
}

export function resetResponsesEventSeq(): void {
  eventSeq = 0;
}

/** 事件按 Responses 协议带递增 sequence_number。 */
export function responsesEvent(type: string, payload: RawRecord = {}): ResponsesEvent {
  return { type, sequence_number: nextSeq(), ...payload };
}

export function responsesId(): string {
  return `resp_${crypto.randomUUID()}`;
}

export function itemId(prefix: "msg" | "fc" | "rs"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
