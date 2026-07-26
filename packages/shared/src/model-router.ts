/** 上游协议：决定 HTTP 适配器、表单字段与预设地址（含 new-api 常见渠道） */
export const MODEL_UPSTREAM_PROTOCOLS = [
  "openai",
  "azure-openai",
  "anthropic",
  "gemini",
  "bailian",
  "deepseek",
  "moonshot",
  "siliconflow",
  "openrouter",
  "zhipu",
  "minimax",
  "ollama",
  "mistral",
  "xai",
  "perplexity",
  "jina",
  "cohere",
  "volcengine",
  "baidu",
  "lingyiwanwu",
  "custom",
] as const;
export type ModelUpstreamProtocol = (typeof MODEL_UPSTREAM_PROTOCOLS)[number];

/** 走 OpenAI 兼容适配器的协议 */
export const OPENAI_COMPATIBLE_PROTOCOLS = [
  "openai",
  "azure-openai",
  "custom",
  "deepseek",
  "moonshot",
  "siliconflow",
  "openrouter",
  "zhipu",
  "minimax",
  "ollama",
  "mistral",
  "xai",
  "perplexity",
  "jina",
  "cohere",
  "volcengine",
  "baidu",
  "lingyiwanwu",
] as const satisfies readonly ModelUpstreamProtocol[];

/** 模型能力类型 */
export const MODEL_CAPABILITIES = [
  "chat",
  "embedding",
  "rerank",
  "image",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 路由选择策略 */
export const MODEL_ROUTE_STRATEGIES = ["priority", "weighted"] as const;
export type ModelRouteStrategy = (typeof MODEL_ROUTE_STRATEGIES)[number];

/** 模型目录数据源 */
export const MODEL_CATALOG_SOURCES = ["models.dev", "llm-metadata"] as const;
export type ModelCatalogSource = (typeof MODEL_CATALOG_SOURCES)[number];

/** 上游表单可见字段（未列出的由协议预设自动填充） */
export const MODEL_UPSTREAM_FORM_FIELDS = [
  "apiKey",
  "baseUrl",
  "apiVersion",
  "anthropicVersion",
  "deploymentId",
  "rerankBaseUrl",
  "region",
] as const;
export type ModelUpstreamFormField = (typeof MODEL_UPSTREAM_FORM_FIELDS)[number];

export type ModelUpstreamRegion = "cn" | "intl";

export type ModelUpstreamProtocolMeta = {
  name: string;
  description: string;
  /** 该类型需要用户填写的字段 */
  fields: ModelUpstreamFormField[];
  /** 搜索关键词（提供商别名） */
  keywords?: string[];
  /** 来源标注，如 new-api ChannelType */
  source?: string;
};

/**
 * 常见模型提供商元数据。
 * 渠道命名参考 QuantumNous/new-api constant/channel.go。
 */
export const MODEL_UPSTREAM_PROTOCOL_META: Record<
  ModelUpstreamProtocol,
  ModelUpstreamProtocolMeta
> = {
  openai: {
    name: "OpenAI",
    description: "OpenAI",
    fields: ["baseUrl", "apiKey"],
    keywords: ["openai", "gpt"],
    source: "new-api:OpenAI",
  },
  "azure-openai": {
    name: "Azure OpenAI",
    description: "Azure OpenAI",
    fields: ["baseUrl", "apiKey", "apiVersion", "deploymentId"],
    keywords: ["azure"],
    source: "new-api:Azure",
  },
  anthropic: {
    name: "Anthropic",
    description: "Anthropic",
    fields: ["baseUrl", "apiKey"],
    keywords: ["claude", "anthropic"],
    source: "new-api:Anthropic",
  },
  gemini: {
    name: "Gemini",
    description: "Gemini",
    fields: ["baseUrl", "apiKey"],
    keywords: ["google", "gemini", "palm"],
    source: "new-api:Gemini",
  },
  bailian: {
    name: "阿里云百炼 DashScope",
    description: "DashScope",
    fields: ["baseUrl", "apiKey", "region"],
    keywords: ["ali", "alibaba", "dashscope", "百炼", "通义"],
    source: "new-api:Ali",
  },
  deepseek: {
    name: "DeepSeek",
    description: "DeepSeek",
    fields: ["baseUrl", "apiKey"],
    keywords: ["deepseek"],
    source: "new-api:DeepSeek",
  },
  moonshot: {
    name: "Moonshot",
    description: "Moonshot",
    fields: ["baseUrl", "apiKey"],
    keywords: ["kimi", "moonshot"],
    source: "new-api:Moonshot",
  },
  siliconflow: {
    name: "SiliconFlow",
    description: "SiliconFlow",
    fields: ["baseUrl", "apiKey"],
    keywords: ["silicon", "硅基"],
    source: "new-api:SiliconFlow",
  },
  openrouter: {
    name: "OpenRouter",
    description: "OpenRouter",
    fields: ["baseUrl", "apiKey"],
    keywords: ["openrouter"],
    source: "new-api:OpenRouter",
  },
  zhipu: {
    name: "智谱 GLM",
    description: "智谱",
    fields: ["baseUrl", "apiKey"],
    keywords: ["zhipu", "glm", "智谱"],
    source: "new-api:ZhipuV4",
  },
  minimax: {
    name: "MiniMax",
    description: "MiniMax",
    fields: ["baseUrl", "apiKey"],
    keywords: ["minimax"],
    source: "new-api:MiniMax",
  },
  ollama: {
    name: "Ollama",
    description: "Ollama",
    fields: ["baseUrl", "apiKey"],
    keywords: ["ollama", "local"],
    source: "new-api:Ollama",
  },
  mistral: {
    name: "Mistral",
    description: "Mistral",
    fields: ["baseUrl", "apiKey"],
    keywords: ["mistral"],
    source: "new-api:Mistral",
  },
  xai: {
    name: "xAI",
    description: "xAI",
    fields: ["baseUrl", "apiKey"],
    keywords: ["xai", "grok"],
    source: "new-api:xAI",
  },
  perplexity: {
    name: "Perplexity",
    description: "Perplexity",
    fields: ["baseUrl", "apiKey"],
    keywords: ["perplexity"],
    source: "new-api:Perplexity",
  },
  jina: {
    name: "Jina",
    description: "Jina",
    fields: ["baseUrl", "apiKey"],
    keywords: ["jina"],
    source: "new-api:Jina",
  },
  cohere: {
    name: "Cohere",
    description: "Cohere",
    fields: ["baseUrl", "apiKey"],
    keywords: ["cohere"],
    source: "new-api:Cohere",
  },
  volcengine: {
    name: "火山方舟",
    description: "火山方舟",
    fields: ["baseUrl", "apiKey"],
    keywords: ["volc", "doubao", "豆包", "方舟"],
    source: "new-api:VolcEngine",
  },
  baidu: {
    name: "百度千帆",
    description: "百度千帆",
    fields: ["baseUrl", "apiKey"],
    keywords: ["baidu", "qianfan", "千帆"],
    source: "new-api:BaiduV2",
  },
  lingyiwanwu: {
    name: "零一万物",
    description: "零一万物",
    fields: ["baseUrl", "apiKey"],
    keywords: ["lingyi", "yi", "零一"],
    source: "new-api:LingYiWanWu",
  },
  custom: {
    name: "自定义",
    description: "自定义",
    fields: ["baseUrl", "apiKey", "rerankBaseUrl"],
    keywords: ["custom", "自定义"],
    source: "new-api:Custom",
  },
};

/** 协议默认 Base URL（参考 new-api ChannelBaseURLs，并补齐 /v1 路径） */
export const MODEL_UPSTREAM_DEFAULT_BASE_URLS: Partial<
  Record<ModelUpstreamProtocol, string>
> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  bailian: "https://dashscope.aliyuncs.com/api/v1",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openrouter: "https://openrouter.ai/api/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimax.chat/v1",
  ollama: "http://127.0.0.1:11434/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  perplexity: "https://api.perplexity.ai",
  jina: "https://api.jina.ai/v1",
  cohere: "https://api.cohere.ai",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  baidu: "https://qianfan.baidubce.com/v2",
  lingyiwanwu: "https://api.lingyiwanwu.com/v1",
};

/** 百炼 DashScope 区域端点 */
export const BAILIAN_ENDPOINTS = {
  cn: { baseUrl: "https://dashscope.aliyuncs.com/api/v1" },
  intl: { baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1" },
} as const;

export const MODEL_CAPABILITY_META: Record<
  ModelCapability,
  { name: string; description: string }
> = {
  chat: { name: "对话", description: "Chat Completions（统一 OpenAI 响应）" },
  embedding: { name: "向量化", description: "文本 Embedding，供记忆检索等" },
  rerank: { name: "重排序", description: "Rerank / Ranker，供检索精排" },
  image: { name: "生图", description: "文生图 / 图像生成" },
};

/** 上游连接配置（存于 model_upstreams.config_json） */
export interface ModelUpstreamConfig {
  baseUrl: string;
  apiKey?: string;
  /** Azure OpenAI api-version */
  apiVersion?: string;
  /** Azure 部署名；未填时回退到路由上的 model 字段 */
  deploymentId?: string;
  /** Anthropic API 版本头，默认 2023-06-01 */
  anthropicVersion?: string;
  /** 百炼 / 自定义 rerank 使用的 base（如 compatible-api/v1） */
  rerankBaseUrl?: string;
  /** 百炼等区域：cn 国内 / intl 国际 */
  region?: ModelUpstreamRegion;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  /**
   * @deprecated 勿再把目录「原始提供商」当成上游。
   * 模型来自用户配置的上游或手填；目录仅用于按 modelId 匹配元数据。
   */
  catalogProviderId?: string;
}

/**
 * 按协议类型合并预设地址与用户输入。
 * 未填写 baseUrl 时使用协议默认值；已填写则保留用户输入。
 */
export function applyUpstreamProtocolDefaults(
  protocol: ModelUpstreamProtocol,
  input: Partial<ModelUpstreamConfig> & Record<string, unknown> = {},
): ModelUpstreamConfig {
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : undefined;
  const region: ModelUpstreamRegion =
    input.region === "intl" ? "intl" : "cn";

  const base: ModelUpstreamConfig = {
    baseUrl:
      typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/$/, "") : "",
    apiKey,
    apiVersion:
      typeof input.apiVersion === "string" ? input.apiVersion.trim() : undefined,
    deploymentId:
      typeof input.deploymentId === "string" ? input.deploymentId.trim() : undefined,
    anthropicVersion:
      typeof input.anthropicVersion === "string"
        ? input.anthropicVersion.trim()
        : undefined,
    rerankBaseUrl:
      typeof input.rerankBaseUrl === "string"
        ? input.rerankBaseUrl.trim().replace(/\/$/, "") || undefined
        : undefined,
    region: input.region === "intl" || input.region === "cn" ? input.region : undefined,
    extraHeaders:
      input.extraHeaders && typeof input.extraHeaders === "object"
        ? (input.extraHeaders as Record<string, string>)
        : undefined,
    timeoutMs:
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : undefined,
  };

  switch (protocol) {
    case "openai":
    case "deepseek":
    case "moonshot":
    case "siliconflow":
    case "openrouter":
    case "zhipu":
    case "minimax":
    case "ollama":
    case "mistral":
    case "xai":
    case "perplexity":
    case "jina":
    case "cohere":
    case "volcengine":
    case "baidu":
    case "lingyiwanwu":
      return {
        ...base,
        baseUrl:
          base.baseUrl || MODEL_UPSTREAM_DEFAULT_BASE_URLS[protocol] || "",
      };
    case "bailian": {
      const ep = BAILIAN_ENDPOINTS[region];
      return {
        ...base,
        region,
        // DashScope 原生 api/v1：embedding + rerank
        baseUrl: base.baseUrl || ep.baseUrl,
        rerankBaseUrl: undefined,
      };
    }
    case "anthropic":
      return {
        ...base,
        baseUrl: base.baseUrl || "https://api.anthropic.com",
        anthropicVersion: base.anthropicVersion || "2023-06-01",
      };
    case "gemini":
      return {
        ...base,
        baseUrl:
          base.baseUrl || "https://generativelanguage.googleapis.com/v1beta",
      };
    case "azure-openai":
      return {
        ...base,
        apiVersion: base.apiVersion || "2024-08-01-preview",
      };
    case "custom":
    default:
      return base;
  }
}

/** 路由级选项（存于 model_routes.options_json） */
export interface ModelRouteOptions {
  dimensions?: number;
  topN?: number;
  temperature?: number;
  maxTokens?: number;
  /** qwen3-rerank 等模型的 instruct */
  instruct?: string;
  size?: string;
  quality?: string;
  responseFormat?: "url" | "b64_json";
  /** 扩展字段：预留 provider-specific / tool 相关选项 */
  extensions?: Record<string, unknown>;
}

/** OpenAI function tool 定义（可扩展） */
export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema object */
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串参数 */
    arguments: string;
  };
}

export type ModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ModelChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  /** assistant 发起的 tool 调用 */
  toolCalls?: ModelToolCall[];
  /** tool 角色回传时的 call id */
  toolCallId?: string;
}

/** chat 调用可选项：tools 等扩展入口 */
export interface ModelChatInvokeOptions {
  tools?: ModelToolDefinition[];
  toolChoice?: ModelToolChoice;
  /** 透传扩展参数（各协议适配器可选择性消费） */
  extensions?: Record<string, unknown>;
}

/** 统一的 OpenAI Chat Completions 响应片段 */
export interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ModelToolCall[];
  };
  finish_reason: string | null;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelChatResult {
  content: string | null;
  model: string;
  finishReason?: string | null;
  toolCalls?: ModelToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** 统一 OpenAI Chat Completions 形状，便于下游无感切换协议 */
  openai: OpenAIChatCompletion;
  raw?: unknown;
}

export interface ModelEmbeddingResult {
  vectors: number[][];
  model: string;
}

export interface ModelRerankDocument {
  index: number;
  score: number;
  text?: string;
}

export interface ModelRerankResult {
  results: ModelRerankDocument[];
  model: string;
}

export interface ModelImageResult {
  images: Array<{ url?: string; b64Json?: string }>;
  model: string;
}

/** 目录中的模型元数据条目（用于匹配，不是安装来源） */
export interface ModelCatalogEntry {
  source: ModelCatalogSource;
  /** 元数据里的厂商 id，仅供参考，不等于用户上游 */
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  description?: string;
  family?: string;
  /** chat | embedding | image 等推断能力 */
  capabilities: ModelCapability[];
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  openWeights?: boolean;
  contextLimit?: number;
  outputLimit?: number;
  modalities?: { input?: string[]; output?: string[] };
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  releaseDate?: string;
  knowledge?: string;
  /** models.dev / metadata 原始 api base（若有，仅参考） */
  apiBase?: string;
  npm?: string;
}

/**
 * 将上游原始模型名规范为系统调度键。
 * 例：DeepSeek-V4-Flash → deepseek-v4-flash
 */
export function normalizeCanonicalModelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9.+:/-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 上游模型库存条目（每上游单独记录） */
export interface UpstreamModelRecord {
  id: string;
  upstreamId: string;
  /** 上游原始调用名 */
  nativeModel: string;
  /** 系统规范名 / 聚合键 */
  canonicalModel: string;
  displayName?: string | null;
  capability: ModelCapability;
  weight: number;
  enabled: boolean;
  isDefault: boolean;
  options?: ModelRouteOptions;
  meta?: Partial<ModelCatalogEntry> & Record<string, unknown>;
  status: string;
  lastError?: string | null;
  syncedAt?: string | null;
}

/** 按规范名聚合后的逻辑模型 */
export interface LogicalModelGroup {
  canonicalModel: string;
  displayName: string;
  capability: ModelCapability;
  isDefault: boolean;
  deployments: UpstreamModelRecord[];
}
