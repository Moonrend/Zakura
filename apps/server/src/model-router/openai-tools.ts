/**
 * OpenAI 兼容上游的 tools 打包：
 * - gpt-5.4+ 且工具面较大时：非常驻走 namespace + defer_loading + tool_search
 * - 分片按语义（read/write/other），超限合并进 external_misc，并优先保留会话里用过的 namespace
 *
 * @see https://developers.openai.com/api/docs/guides/tools-tool-search
 */
import type { ModelChatMessage, ModelToolDefinition } from "@zakura/shared";

/** Chat Completions / 多数网关对 tools 数组的硬上限 */
export const OPENAI_TOOLS_ARRAY_MAX = 128;

/** OpenAI 建议每个 namespace < 10 个 function */
export const TOOL_SEARCH_NAMESPACE_MAX_TOOLS = 10;

/**
 * 启用 tool_search 的门槛：工具太少时扁平更跟手。
 * 超过硬上限时无视此门槛，必须打包。
 */
export const TOOL_SEARCH_MIN_TOTAL_TOOLS = 48;
export const TOOL_SEARCH_MIN_DEFERRED_TOOLS = 12;

/** 超限时把挤掉的小包合并进此 namespace，而不是静默丢弃 */
export const TOOL_SEARCH_OVERFLOW_NAMESPACE = "external_misc";

export type OpenAiToolsPackResult = {
  tools: unknown[];
  /** 是否走了 tool_search / namespace 打包 */
  usedToolSearch: boolean;
  /** 被合并进 external_misc 或截断掉的原 namespace 名 */
  omittedNamespaces: string[];
  warning?: string;
};

/** gpt-5.4 及更高（含 gpt-5.6-luna 等后缀） */
export function supportsToolSearch(model: string | undefined | null): boolean {
  if (!model) return false;
  return /gpt-5\.(?:[4-9]|\d{2,})\b/i.test(model);
}

export function shouldUseToolSearchPack(
  model: string | undefined | null,
  alwaysOnCount: number,
  deferredCount: number,
): boolean {
  if (!supportsToolSearch(model) || deferredCount <= 0) return false;
  const total = alwaysOnCount + deferredCount;
  if (total > OPENAI_TOOLS_ARRAY_MAX) return true;
  return (
    total >= TOOL_SEARCH_MIN_TOTAL_TOOLS || deferredCount >= TOOL_SEARCH_MIN_DEFERRED_TOOLS
  );
}

function toChatFunctionTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
      ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
    },
  };
}

/** Responses / tool_search：扁平 function */
export function toFlatFunctionTool(
  tool: ModelToolDefinition,
  deferLoading: boolean,
): Record<string, unknown> {
  return {
    type: "function",
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
    ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
    ...(deferLoading ? { defer_loading: true } : {}),
  };
}

function partitionTools(tools: ModelToolDefinition[]): {
  alwaysOn: ModelToolDefinition[];
  deferred: ModelToolDefinition[];
} {
  const alwaysOn: ModelToolDefinition[] = [];
  const deferred: ModelToolDefinition[] = [];
  for (const tool of tools) {
    if (tool.deferLoading) deferred.push(tool);
    else alwaysOn.push(tool);
  }
  return { alwaysOn, deferred };
}

export type NamespaceGroup = {
  name: string;
  description: string;
  tools: ModelToolDefinition[];
};

export function shortToolLabel(functionName: string): string {
  const bare = functionName.replace(/^re_/, "");
  const parts = bare.split("__");
  return (parts.length > 1 ? parts[parts.length - 1] : bare) || functionName;
}

export function describeNamespaceTools(baseDescription: string): string {
  return baseDescription.trim().replace(/\.+$/, "") + ".";
}

/** read / write / other —— 语义分片，避免 gmail_2 这种无意义切片 */
export type SemanticBucket = "read" | "write" | "other";

export function semanticBucketForToolName(functionName: string): SemanticBucket {
  const label = shortToolLabel(functionName).toLowerCase();
  if (
    /^(list|get|search|find|read|fetch|query|lookup|describe|stat|show|view|browse|download|export)/.test(
      label,
    ) ||
    /_(list|get|search|find|read|fetch|query|lookup|stat)$/.test(label)
  ) {
    return "read";
  }
  if (
    /^(create|add|send|update|edit|delete|remove|write|put|post|patch|set|upload|insert|revoke|pin|link|move|mkdir|unexpose|expose|install)/.test(
      label,
    ) ||
    /_(create|add|send|update|delete|write|remove|set)$/.test(label)
  ) {
    return "write";
  }
  return "other";
}

const BUCKET_SUFFIX: Record<SemanticBucket, string> = {
  read: "_read",
  write: "_write",
  other: "_other",
};

const BUCKET_LABEL: Record<SemanticBucket, string> = {
  read: "read/list/search",
  write: "create/update/delete/send",
  other: "other operations",
};

function groupDeferredByNamespace(deferred: ModelToolDefinition[]): NamespaceGroup[] {
  const groups = new Map<string, NamespaceGroup>();
  for (const tool of deferred) {
    const name = tool.namespace?.name?.trim() || "external";
    const description =
      tool.namespace?.description?.trim() || `Deferred tools for ${name}`;
    const hit = groups.get(name);
    if (hit) hit.tools.push(tool);
    else groups.set(name, { name, description, tools: [tool] });
  }
  return [...groups.values()];
}

/**
 * 单包 ≤ max 保持；更大则按语义拆成 base_read / base_write / base_other。
 * 若某一语义桶仍 > max，再按数量切（极少见）。
 */
export function shardNamespaceGroups(
  groups: NamespaceGroup[],
  maxTools = TOOL_SEARCH_NAMESPACE_MAX_TOOLS,
): NamespaceGroup[] {
  if (maxTools < 1) return groups;
  const out: NamespaceGroup[] = [];
  for (const group of groups) {
    if (group.tools.length <= maxTools) {
      out.push({
        ...group,
        description: describeNamespaceTools(group.description),
      });
      continue;
    }
    const buckets: Record<SemanticBucket, ModelToolDefinition[]> = {
      read: [],
      write: [],
      other: [],
    };
    for (const tool of group.tools) {
      buckets[semanticBucketForToolName(tool.function.name)].push(tool);
    }
    const active = (Object.keys(buckets) as SemanticBucket[]).filter(
      (b) => buckets[b].length > 0,
    );
    for (const bucket of active) {
      const tools = buckets[bucket];
      const baseName = `${group.name}${BUCKET_SUFFIX[bucket]}`.slice(0, 64);
      const baseDesc = `${group.description.replace(/\.+$/, "")} — ${BUCKET_LABEL[bucket]}`;
      if (tools.length <= maxTools) {
        out.push({
          name: baseName,
          description: describeNamespaceTools(baseDesc),
          tools,
        });
        continue;
      }
      // 语义桶仍过大：不得已按数量切，后缀 _2/_3
      const parts = Math.ceil(tools.length / maxTools);
      for (let i = 0; i < parts; i += 1) {
        const slice = tools.slice(i * maxTools, (i + 1) * maxTools);
        const suffix = i === 0 ? "" : `_${i + 1}`;
        out.push({
          name: `${baseName}${suffix}`.slice(0, 64),
          description: describeNamespaceTools(
            `${baseDesc} (part ${i + 1}/${parts})`,
          ),
          tools: slice,
        });
      }
    }
  }
  return out;
}

/** 从对话历史里已调用的 tool 名，推断应优先保留的 namespace */
export function preferredNamespacesFromMessages(
  messages: ModelChatMessage[] | undefined,
  groups: NamespaceGroup[],
): string[] {
  if (!messages?.length || !groups.length) return [];
  const called = new Set<string>();
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.function?.name) called.add(tc.function.name);
    }
  }
  if (!called.size) return [];
  const preferred: string[] = [];
  for (const g of groups) {
    if (g.tools.some((t) => called.has(t.function.name))) preferred.push(g.name);
  }
  return preferred;
}

function rankNamespaces(
  groups: NamespaceGroup[],
  preferred: string[],
): NamespaceGroup[] {
  const pref = new Set(preferred);
  return [...groups].sort((a, b) => {
    const ap = pref.has(a.name) ? 1 : 0;
    const bp = pref.has(b.name) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.tools.length - a.tools.length;
  });
}

function chunkToolsAsMisc(
  tools: ModelToolDefinition[],
  omittedNames: string[],
  maxTools = TOOL_SEARCH_NAMESPACE_MAX_TOOLS,
): NamespaceGroup[] {
  if (!tools.length) return [];
  const parts = Math.ceil(tools.length / maxTools);
  const from = omittedNames.slice(0, 8).join(", ");
  const more = omittedNames.length > 8 ? ` (+${omittedNames.length - 8} more)` : "";
  return Array.from({ length: parts }, (_, i) => ({
    name:
      parts === 1
        ? TOOL_SEARCH_OVERFLOW_NAMESPACE
        : `${TOOL_SEARCH_OVERFLOW_NAMESPACE}_${i + 1}`.slice(0, 64),
    description: describeNamespaceTools(
      `Overflow/misc deferred tools merged from: ${from}${more}${
        parts > 1 ? ` (part ${i + 1}/${parts})` : ""
      }`,
    ),
    tools: tools.slice(i * maxTools, (i + 1) * maxTools),
  }));
}

/**
 * 顶层放不下时：保留靠前的 namespace，把其余合并进 external_misc*（仍可被 tool_search 搜到）。
 * misc 按 ≤10 切分；槽位不够时再截断并记入 omitted。
 */
export function fitNamespacesToRoom(
  namespaces: NamespaceGroup[],
  room: number,
): { kept: NamespaceGroup[]; omitted: string[]; mergedIntoMisc: boolean } {
  if (room <= 0) {
    return {
      kept: [],
      omitted: namespaces.map((n) => n.name),
      mergedIntoMisc: false,
    };
  }
  if (namespaces.length <= room) {
    return { kept: namespaces, omitted: [], mergedIntoMisc: false };
  }

  // 先估 overflow 工具数，再决定留几个槽给 misc 分片
  let directRoom = room - 1;
  let overflow = namespaces.slice(Math.max(0, directRoom));
  let miscShards = chunkToolsAsMisc(
    overflow.flatMap((n) => n.tools),
    overflow.map((n) => n.name),
  );
  while (miscShards.length > 1 && directRoom > 0 && 1 + miscShards.length > room) {
    directRoom -= 1;
    overflow = namespaces.slice(directRoom);
    miscShards = chunkToolsAsMisc(
      overflow.flatMap((n) => n.tools),
      overflow.map((n) => n.name),
    );
  }

  const kept = namespaces.slice(0, Math.max(0, directRoom));
  const omitted = overflow.map((n) => n.name);
  const roomForMisc = Math.max(0, room - kept.length);
  const fittedMisc = miscShards.slice(0, roomForMisc);
  // 分片仍装不下：丢掉末尾分片里的工具（对应 namespace 已在 omitted）
  kept.push(...fittedMisc);
  return { kept, omitted, mergedIntoMisc: fittedMisc.length > 0 };
}

function toNamespaceTool(group: NamespaceGroup): Record<string, unknown> {
  return {
    type: "namespace",
    name: group.name,
    description: group.description,
    tools: group.tools.map((t) => toFlatFunctionTool(t, true)),
  };
}

export type PackOpenAiToolsOptions = {
  /** Chat Completions 嵌套 function；Responses 用扁平 */
  format?: "chat" | "responses";
  messages?: ModelChatMessage[];
};

/**
 * 将内部 ModelToolDefinition[] 打成上游 tools 载荷。
 */
export function packOpenAiChatTools(
  tools: ModelToolDefinition[] | undefined,
  model: string | undefined | null,
  opts?: PackOpenAiToolsOptions,
): OpenAiToolsPackResult | undefined {
  if (!tools?.length) return undefined;

  const format = opts?.format ?? "chat";
  const mapAlways =
    format === "responses"
      ? (t: ModelToolDefinition) => toFlatFunctionTool(t, false)
      : toChatFunctionTool;

  const { alwaysOn, deferred } = partitionTools(tools);

  if (shouldUseToolSearchPack(model, alwaysOn.length, deferred.length)) {
    const rawGroups = shardNamespaceGroups(groupDeferredByNamespace(deferred));
    const preferred = preferredNamespacesFromMessages(opts?.messages, rawGroups);
    const ranked = rankNamespaces(rawGroups, preferred);

    const maxAlways = Math.max(0, OPENAI_TOOLS_ARRAY_MAX - 1);
    const keptAlways =
      alwaysOn.length > maxAlways ? alwaysOn.slice(0, maxAlways) : alwaysOn;
    if (keptAlways.length < alwaysOn.length) {
      console.warn(
        `[openai-tools] always-on tools ${alwaysOn.length} exceed room before tool_search; truncated to ${keptAlways.length}`,
      );
    }
    const roomForNs = Math.max(0, OPENAI_TOOLS_ARRAY_MAX - keptAlways.length - 1);
    const { kept, omitted, mergedIntoMisc } = fitNamespacesToRoom(ranked, roomForNs);
    let warning: string | undefined;
    if (omitted.length) {
      warning = mergedIntoMisc
        ? `Merged ${omitted.length} namespaces into ${TOOL_SEARCH_OVERFLOW_NAMESPACE}: ${omitted.join(", ")}`
        : `Omitted namespaces (no room): ${omitted.join(", ")}`;
      console.warn(`[openai-tools] ${warning}`);
    }
    return {
      tools: [
        ...keptAlways.map(mapAlways),
        ...kept.map(toNamespaceTool),
        { type: "tool_search" },
      ],
      usedToolSearch: true,
      omittedNamespaces: omitted,
      ...(warning ? { warning } : {}),
    };
  }

  // 无 tool_search：扁平；超限时优先常驻
  if (alwaysOn.length >= OPENAI_TOOLS_ARRAY_MAX) {
    const warning =
      alwaysOn.length > OPENAI_TOOLS_ARRAY_MAX || deferred.length > 0
        ? `always-on ${alwaysOn.length} fills/exceeds ${OPENAI_TOOLS_ARRAY_MAX}; dropping deferred=${deferred.length}`
        : undefined;
    if (warning) console.warn(`[openai-tools] ${warning} (model=${model ?? "?"})`);
    return {
      tools: alwaysOn.slice(0, OPENAI_TOOLS_ARRAY_MAX).map(mapAlways),
      usedToolSearch: false,
      omittedNamespaces: [],
      ...(warning ? { warning } : {}),
    };
  }
  const room = OPENAI_TOOLS_ARRAY_MAX - alwaysOn.length;
  const dropped = deferred.length > room ? deferred.length - room : 0;
  const warning =
    dropped > 0
      ? `tools ${alwaysOn.length + deferred.length} > ${OPENAI_TOOLS_ARRAY_MAX}; keeping ${alwaysOn.length} always-on + ${room} deferred`
      : undefined;
  if (warning) console.warn(`[openai-tools] ${warning} (model=${model ?? "?"})`);
  return {
    tools: [...alwaysOn, ...deferred.slice(0, room)].map(mapAlways),
    usedToolSearch: false,
    omittedNamespaces: [],
    ...(warning ? { warning } : {}),
  };
}
