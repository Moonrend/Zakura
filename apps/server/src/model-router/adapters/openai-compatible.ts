import type {
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelImageResult,
  ModelRerankResult,
  ModelUpstreamProtocol,
} from "@zakura/shared";
import { OPENAI_COMPATIBLE_PROTOCOLS } from "@zakura/shared";
import {
  parseOpenAIToolCalls,
  type ChatStreamCallbacks,
  type ModelProtocolAdapter,
} from "../adapter.js";
import { apiError, buildHeaders, httpJson, httpSse } from "../http.js";
import {
  absorbChatStreamChunk,
  buildOpenAIChatCompletion,
  chatStreamStateToResult,
  createChatStreamState,
  toModelChatResult,
} from "../openai-response.js";
import type { ResolvedRoute } from "../types.js";

type OpenAiCompatProtocol = (typeof OPENAI_COMPATIBLE_PROTOCOLS)[number];

function chatUrl(route: ResolvedRoute): string {
  const { config, protocol } = route.upstream;
  const deployment = config.deploymentId ?? route.model;
  if (protocol === "azure-openai") {
    const ver = config.apiVersion ?? "2024-08-01-preview";
    return `${config.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(ver)}`;
  }
  return `${config.baseUrl}/chat/completions`;
}

function embedUrl(route: ResolvedRoute): string {
  const { config, protocol } = route.upstream;
  if (protocol === "azure-openai") {
    const deployment = config.deploymentId ?? route.model;
    const ver = config.apiVersion ?? "2024-08-01-preview";
    return `${config.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(ver)}`;
  }
  return `${config.baseUrl}/embeddings`;
}

function rerankUrl(route: ResolvedRoute): string {
  const base = route.upstream.config.rerankBaseUrl ?? route.upstream.config.baseUrl;
  return `${base}/reranks`;
}

function imageUrl(route: ResolvedRoute): string {
  const { config, protocol } = route.upstream;
  if (protocol === "azure-openai") {
    const deployment = config.deploymentId ?? route.model;
    const ver = config.apiVersion ?? "2024-08-01-preview";
    return `${config.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/images/generations?api-version=${encodeURIComponent(ver)}`;
  }
  return `${config.baseUrl}/images/generations`;
}

function timeout(route: ResolvedRoute): number {
  return route.upstream.config.timeoutMs ?? 60000;
}

function mapMessages(messages: ModelChatMessage[]) {
  return messages.map((m) => {
    const base: Record<string, unknown> = {
      role: m.role,
      content: m.content,
    };
    // 多模态：user 消息带 parts 时转 OpenAI content 数组
    if (m.role === "user" && m.parts?.length) {
      base.content = m.parts.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "image_url", image_url: { url: p.imageUrl.url } },
      );
    }
    if (m.name) base.name = m.name;
    if (m.toolCallId) base.tool_call_id = m.toolCallId;
    if (m.toolCalls?.length) base.tool_calls = m.toolCalls;
    return base;
  });
}

async function chat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    messages: mapMessages(messages),
  };
  if (route.options.temperature != null) body.temperature = route.options.temperature;
  if (route.options.maxTokens != null) body.max_tokens = route.options.maxTokens;
  if (options?.tools?.length) body.tools = options.tools;
  if (options?.toolChoice) body.tool_choice = options.toolChoice;
  if (options?.extensions) Object.assign(body, options.extensions);

  const res = await httpJson<{
    id?: string;
    created?: number;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: unknown;
      };
      finish_reason?: string | null;
    }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  }>(chatUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("chat", res.status, res.data, res.text);

  const choice = res.data?.choices?.[0];
  const toolCalls = parseOpenAIToolCalls(choice?.message?.tool_calls);
  const openai = buildOpenAIChatCompletion({
    id: res.data?.id,
    created: res.data?.created,
    model: res.data?.model ?? route.model,
    content: choice?.message?.content ?? null,
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
    usage: res.data?.usage
      ? {
          promptTokens: res.data.usage.prompt_tokens,
          completionTokens: res.data.usage.completion_tokens,
          totalTokens: res.data.usage.total_tokens,
        }
      : undefined,
  });
  return toModelChatResult(openai, res.data);
}

/** SSE 流式 chat：解析 data: 行累积 delta；连接失败/非 2xx 抛错由上层回退 */
async function chatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options: ModelChatInvokeOptions | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    messages: mapMessages(messages),
    stream: true,
  };
  if (route.options.temperature != null) body.temperature = route.options.temperature;
  if (route.options.maxTokens != null) body.max_tokens = route.options.maxTokens;
  if (options?.tools?.length) body.tools = options.tools;
  if (options?.toolChoice) body.tool_choice = options.toolChoice;
  if (options?.extensions) Object.assign(body, options.extensions);

  const state = createChatStreamState();
  let stopped = false;
  await httpSse(
    "chat(stream)",
    chatUrl(route),
    {
      method: "POST",
      headers: {
        ...buildHeaders(route.upstream.config, route.upstream.protocol),
        Accept: "text/event-stream",
      },
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
      body: JSON.stringify(body),
      timeoutMs: timeout(route),
    },
    (payload) => {
      if (stopped) return;
      if (payload === "[DONE]") {
        stopped = true;
        return;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const err = (chunk as { error?: { message?: string } }).error;
      if (err?.message) throw new Error(`chat(stream) upstream error: ${err.message}`);
      const delta = absorbChatStreamChunk(state, chunk);
      if (delta) callbacks.onDelta?.(delta);
    },
  );
  return chatStreamStateToResult(state, route.model);
}

async function embed(
  route: ResolvedRoute,
  texts: string[],
): Promise<ModelEmbeddingResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    input: texts.length === 1 ? texts[0] : texts,
  };
  if (route.options.dimensions) body.dimensions = route.options.dimensions;

  const res = await httpJson<{
    data?: Array<{ embedding?: number[]; index?: number }>;
    model?: string;
    error?: { message?: string };
  }>(embedUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("embedding", res.status, res.data, res.text);
  const rows = [...(res.data?.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  if (rows.length !== texts.length) {
    throw new Error(`embedding count mismatch: expected ${texts.length}, got ${rows.length}`);
  }
  return {
    vectors: rows.map((r) => {
      const v = r.embedding;
      if (!Array.isArray(v) || v.length === 0) throw new Error("embedding response missing vector");
      return v.map(Number);
    }),
    model: res.data?.model ?? route.model,
  };
}

async function rerank(
  route: ResolvedRoute,
  query: string,
  documents: string[],
): Promise<ModelRerankResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    query,
    documents,
  };
  if (route.options.topN != null) body.top_n = route.options.topN;
  if (route.options.instruct) body.instruct = route.options.instruct;

  const res = await httpJson<{
    results?: Array<{ index?: number; relevance_score?: number; document?: { text?: string } }>;
    model?: string;
    error?: { message?: string };
  }>(rerankUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route),
  });
  if (!res.ok) throw apiError("rerank", res.status, res.data, res.text);
  return {
    results: (res.data?.results ?? []).map((r, i) => ({
      index: r.index ?? i,
      score: r.relevance_score ?? 0,
      text: r.document?.text ?? documents[r.index ?? i],
    })),
    model: res.data?.model ?? route.model,
  };
}

async function generateImage(
  route: ResolvedRoute,
  prompt: string,
): Promise<ModelImageResult> {
  const body: Record<string, unknown> = {
    model: route.model,
    prompt,
    n: 1,
  };
  if (route.options.size) body.size = route.options.size;
  if (route.options.quality) body.quality = route.options.quality;
  if (route.options.responseFormat) body.response_format = route.options.responseFormat;

  const res = await httpJson<{
    data?: Array<{ url?: string; b64_json?: string }>;
    model?: string;
    error?: { message?: string };
  }>(imageUrl(route), {
    method: "POST",
    headers: buildHeaders(route.upstream.config, route.upstream.protocol),
    body: JSON.stringify(body),
    timeoutMs: timeout(route) * 2,
  });
  if (!res.ok) throw apiError("image", res.status, res.data, res.text);
  return {
    images: (res.data?.data ?? []).map((d) => ({
      url: d.url,
      b64Json: d.b64_json,
    })),
    model: res.data?.model ?? route.model,
  };
}

const handlers = { chat, chatStream, embed, rerank, generateImage };

/** OpenAI / Azure / 自定义及 new-api 常见兼容渠道共享实现 */
export function createOpenAiCompatibleAdapter(
  protocol: OpenAiCompatProtocol | ModelUpstreamProtocol,
): ModelProtocolAdapter {
  return {
    protocol: protocol as ModelUpstreamProtocol,
    supportedCapabilities: ["chat", "embedding", "rerank", "image"],
    ...handlers,
  };
}

export const openAiAdapter = createOpenAiCompatibleAdapter("openai");
export const azureOpenAiAdapter = createOpenAiCompatibleAdapter("azure-openai");
export const customAdapter = createOpenAiCompatibleAdapter("custom");

/** 为 new-api 常见 OpenAI 兼容渠道批量注册 */
export function createOpenAiCompatibleAdapters(): ModelProtocolAdapter[] {
  return OPENAI_COMPATIBLE_PROTOCOLS.map((p) => createOpenAiCompatibleAdapter(p));
}
