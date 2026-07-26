import type {
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelToolCall,
} from "@zakura/shared";
import {
  parseDataUri,
  type ChatStreamCallbacks,
  type ModelProtocolAdapter,
} from "../adapter.js";
import { apiError, httpJson, httpSse, mapConcurrent } from "../http.js";
import { buildOpenAIChatCompletion, toModelChatResult } from "../openai-response.js";
import type { ResolvedRoute } from "../types.js";

const GEMINI_EMBED_CONCURRENCY = 8;

function apiKey(route: ResolvedRoute): string {
  const key = route.upstream.config.apiKey;
  if (!key) throw new Error("Gemini 上游需要配置 apiKey");
  return key;
}

function timeout(route: ResolvedRoute): number {
  return route.upstream.config.timeoutMs ?? 60000;
}

function geminiRole(role: ModelChatMessage["role"]): string {
  if (role === "assistant") return "model";
  return "user";
}

function toGeminiContents(messages: ModelChatMessage[]) {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n");

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name ?? "tool",
              response: { result: m.content ?? "" },
            },
          },
        ],
      });
      continue;
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = { raw: tc.function.arguments };
        }
        parts.push({
          functionCall: { name: tc.function.name, args },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    // 多模态：user 消息带 parts 时转 inline_data / file_data
    if (m.role === "user" && m.parts?.length) {
      const parts: Array<Record<string, unknown>> = [];
      for (const p of m.parts) {
        if (p.type === "text") {
          if (p.text) parts.push({ text: p.text });
          continue;
        }
        const dataUri = parseDataUri(p.imageUrl.url);
        if (dataUri) {
          parts.push({
            inline_data: { mime_type: dataUri.mimeType, data: dataUri.base64 },
          });
        } else {
          parts.push({ file_data: { file_uri: p.imageUrl.url } });
        }
      }
      if (parts.length) {
        contents.push({ role: "user", parts });
        continue;
      }
    }

    contents.push({
      role: geminiRole(m.role),
      parts: [{ text: m.content ?? "" }],
    });
  }

  return { systemParts, contents };
}

function mapTools(options?: ModelChatInvokeOptions) {
  if (!options?.tools?.length) return undefined;
  return [
    {
      functionDeclarations: options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters ?? { type: "object", properties: {} },
      })),
    },
  ];
}

const FINISH_MAP: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
};

function buildChatBody(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Record<string, unknown> {
  const { systemParts, contents } = toGeminiContents(messages);
  const body: Record<string, unknown> = { contents };
  const genConfig: Record<string, unknown> = {};
  if (route.options.temperature != null) genConfig.temperature = route.options.temperature;
  if (route.options.maxTokens != null) genConfig.maxOutputTokens = route.options.maxTokens;
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;
  if (systemParts) {
    body.systemInstruction = { parts: [{ text: systemParts }] };
  }
  const tools = mapTools(options);
  if (tools) body.tools = tools;
  if (options?.extensions) Object.assign(body, options.extensions);
  return body;
}

async function chat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const url = `${route.upstream.config.baseUrl}/models/${encodeURIComponent(route.model)}:generateContent?key=${encodeURIComponent(apiKey(route))}`;
  const body = buildChatBody(route, messages, options);

  const res = await httpJson<{
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name?: string; args?: unknown };
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    error?: { message?: string };
  }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("gemini chat", res.status, res.data, res.text);

  const candidate = res.data?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const textParts: string[] = [];
  const toolCalls: NonNullable<ModelChatResult["toolCalls"]> = [];
  let toolIdx = 0;
  for (const p of parts) {
    if (p.text) textParts.push(p.text);
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `call_gemini_${toolIdx++}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }

  const finishReason = candidate?.finishReason
    ? (FINISH_MAP[candidate.finishReason] ?? candidate.finishReason.toLowerCase())
    : toolCalls.length
      ? "tool_calls"
      : "stop";

  const usage = res.data?.usageMetadata;
  const openai = buildOpenAIChatCompletion({
    model: route.model,
    content: textParts.join("") || null,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    usage: usage
      ? {
          promptTokens: usage.promptTokenCount,
          completionTokens: usage.candidatesTokenCount,
          totalTokens: usage.totalTokenCount,
        }
      : undefined,
  });
  return toModelChatResult(openai, res.data);
}

/** Gemini streamGenerateContent 分片的累积状态 */
export type GeminiStreamState = {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
};

export function createGeminiStreamState(): GeminiStreamState {
  return { text: "", toolCalls: [], finishReason: null };
}

/** 吸收一个流式 GenerateContentResponse 分片，返回新增文本 */
export function absorbGeminiStreamChunk(state: GeminiStreamState, chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const o = chunk as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    error?: { message?: string };
  };
  if (o.error?.message) throw new Error(`gemini stream error: ${o.error.message}`);
  if (o.usageMetadata) {
    state.usage = {
      promptTokens: o.usageMetadata.promptTokenCount,
      completionTokens: o.usageMetadata.candidatesTokenCount,
      totalTokens: o.usageMetadata.totalTokenCount,
    };
  }
  const candidate = o.candidates?.[0];
  if (!candidate) return "";
  if (candidate.finishReason) state.finishReason = candidate.finishReason;
  let added = "";
  for (const p of candidate.content?.parts ?? []) {
    if (p.text) {
      state.text += p.text;
      added += p.text;
    }
    if (p.functionCall?.name) {
      state.toolCalls.push({
        id: `call_gemini_${state.toolCalls.length}`,
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }
  return added;
}

export function geminiStreamStateToResult(
  state: GeminiStreamState,
  model: string,
): ModelChatResult {
  const finishReason = state.finishReason
    ? (FINISH_MAP[state.finishReason] ?? state.finishReason.toLowerCase())
    : state.toolCalls.length
      ? "tool_calls"
      : "stop";
  const openai = buildOpenAIChatCompletion({
    model,
    content: state.text || null,
    toolCalls: state.toolCalls.length ? state.toolCalls : undefined,
    finishReason,
    usage: state.usage,
  });
  return toModelChatResult(openai);
}

async function chatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options: ModelChatInvokeOptions | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  const url = `${route.upstream.config.baseUrl}/models/${encodeURIComponent(route.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey(route))}`;
  const body = buildChatBody(route, messages, options);
  const state = createGeminiStreamState();
  await httpSse(
    "gemini chat(stream)",
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      timeoutMs: timeout(route),
    },
    (payload) => {
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = absorbGeminiStreamChunk(state, chunk);
      if (delta) callbacks.onDelta?.(delta);
    },
  );
  return geminiStreamStateToResult(state, route.model);
}

async function embedOne(route: ResolvedRoute, text: string): Promise<number[]> {
  const url = `${route.upstream.config.baseUrl}/models/${encodeURIComponent(route.model)}:embedContent?key=${encodeURIComponent(apiKey(route))}`;
  const body: Record<string, unknown> = {
    content: { parts: [{ text }] },
  };
  if (route.options.dimensions) {
    body.outputDimensionality = route.options.dimensions;
  }
  const res = await httpJson<{
    embedding?: { values?: number[] };
    error?: { message?: string };
  }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("gemini embedding", res.status, res.data, res.text);
  const values = res.data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("gemini embedding response missing vector");
  }
  return values.map(Number);
}

async function embed(
  route: ResolvedRoute,
  texts: string[],
): Promise<ModelEmbeddingResult> {
  const vectors = await mapConcurrent(texts, GEMINI_EMBED_CONCURRENCY, (text) =>
    embedOne(route, text),
  );
  return { vectors, model: route.model };
}

async function generateImage(
  route: ResolvedRoute,
  prompt: string,
): Promise<ModelImageResult> {
  const url = `${route.upstream.config.baseUrl}/models/${encodeURIComponent(route.model)}:predict?key=${encodeURIComponent(apiKey(route))}`;
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      ...(route.options.size ? { aspectRatio: route.options.size } : {}),
    },
  };
  const res = await httpJson<{
    predictions?: Array<{ bytesBase64Encoded?: string }>;
    error?: { message?: string };
  }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: timeout(route) * 2,
  });
  if (!res.ok) throw apiError("gemini image", res.status, res.data, res.text);
  return {
    images: (res.data?.predictions ?? []).map((p) => ({
      b64Json: p.bytesBase64Encoded,
    })),
    model: route.model,
  };
}

export const geminiAdapter: ModelProtocolAdapter = {
  protocol: "gemini",
  supportedCapabilities: ["chat", "embedding", "image"],
  chat,
  chatStream,
  embed,
  generateImage,
};
