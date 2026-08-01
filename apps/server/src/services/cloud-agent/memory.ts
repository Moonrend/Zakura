/**
 * 自动记忆：运行后由模型判断本轮对话是否有值得长期记住的信息并写入。
 * 提取结果解析对模型输出格式保持宽容（代码围栏、前后杂文）。
 */
import type { CloudAgentConfig } from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import type { ModelRouterService } from "../model-router.js";
import type { MemoryStore } from "../memory-store.js";
import { MEMORY_LAYERS } from "../memory-store.js";
import type { ResolvedMemory } from "../memory-runtime.js";
import { withEmbedding } from "../memory-embed.js";
import { Mem0Client } from "../mem0-client.js";

/** 从模型输出中解析记忆提取 JSON（容忍代码围栏与前后杂文） */
export function parseMemoryExtraction(
  text: string,
): Array<{ content: string; layer?: string; importance?: number; tags?: string[] }> {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) body = fence[1].trim();
  const start = body.search(/[[{]/);
  if (start < 0) return [];
  body = body.slice(start);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (end >= 0) body = body.slice(0, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : [];
  const out: Array<{ content: string; layer?: string; importance?: number; tags?: string[] }> = [];
  for (const item of arr) {
    if (out.length >= 5) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!content || content.length > 600) continue;
    out.push({
      content,
      layer:
        typeof o.layer === "string" && (MEMORY_LAYERS as readonly string[]).includes(o.layer)
          ? o.layer
          : undefined,
      importance:
        typeof o.importance === "number" && o.importance >= 1 && o.importance <= 5
          ? Math.round(o.importance)
          : undefined,
      tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : undefined,
    });
  }
  return out;
}

export async function extractAndSaveMemories(
  deps: { modelRouter: ModelRouterService; memoryStore: MemoryStore | null },
  input: {
    tenantId: string;
    agent: Agent;
    cloud: CloudAgentConfig;
    resolved: ResolvedMemory;
    userContent: string;
    assistantContent: string;
  },
): Promise<Array<{ id?: string; content: string; layer?: string }>> {
  const { tenantId, agent, cloud, resolved } = input;

  const res = await deps.modelRouter.chat(
    tenantId,
    [
      {
        role: "system",
        content: [
          "你是记忆提取器。判断这轮对话里是否有值得长期记住的用户信息。",
          "值得记住：用户身份/偏好/习惯、长期项目与目标、稳定事实、重要约定。",
          "不要记：一次性任务细节、临时状态、可随时重新查询的内容、助手自己的输出。",
          `layer 可选值：${MEMORY_LAYERS.join(", ")}。`,
          '严格输出 JSON：{"memories":[{"content":"…","layer":"fact","importance":3,"tags":[]}]}',
          '没有值得记住的内容时输出 {"memories":[]}。content 用第三人称中文陈述，单条不超过 100 字。',
        ].join("\n"),
      },
      {
        role: "user",
        content: `用户：${input.userContent.slice(0, 3000)}\n\n助手：${input.assistantContent.slice(0, 2000)}`,
      },
    ],
    {
      capability: "chat",
      ...(cloud.modelRouteId
        ? { routeId: cloud.modelRouteId }
        : cloud.model
          ? { alias: cloud.model }
          : {}),
    },
  );

  const candidates = parseMemoryExtraction(res.content ?? "");
  if (candidates.length === 0) return [];

  // 去重：与已有记忆内容（规范化后）完全一致的跳过
  const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const existing = new Set<string>();
  if (resolved.storesLocally && deps.memoryStore) {
    const rows = await deps.memoryStore.list(tenantId, agent.id, { limit: 200 });
    for (const r of rows) existing.add(normalize(r.content));
  }

  const saved: Array<{ id?: string; content: string; layer?: string }> = [];
  for (const cand of candidates) {
    if (existing.has(normalize(cand.content))) continue;

    if (resolved.storesLocally && deps.memoryStore) {
      const base = {
        content: cand.content,
        layer: cand.layer ?? "fact",
        importance: cand.importance ?? 3,
        tags: cand.tags,
        source: "auto",
        providerId: resolved.provider.id,
      };
      const { input: withEmb } = await withEmbedding(base, resolved.config, {
        tenantId,
        modelRouter: deps.modelRouter,
      });
      const row = await deps.memoryStore.add(tenantId, agent.id, withEmb);
      saved.push({ id: row.id, content: row.content, layer: row.layer });
    } else if (resolved.kind === "mem0") {
      const client = Mem0Client.fromConfig(resolved.config);
      const item = await client.add({
        content: cand.content,
        agentId: agent.id,
        userId:
          typeof resolved.config.defaultUserId === "string"
            ? resolved.config.defaultUserId
            : "default",
        metadata: { source: "auto", layer: cand.layer ?? "fact" },
      });
      saved.push({
        id: typeof item?.id === "string" ? item.id : undefined,
        content: cand.content,
        layer: cand.layer,
      });
    }
  }
  return saved;
}
