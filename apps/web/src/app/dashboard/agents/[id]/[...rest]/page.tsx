"use client";

import { useEffect } from "react";
import { notFound, useParams, useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";
import { api } from "@/lib/api";
import type { AgentListItem } from "@/lib/agents";

/**
 * 旧 /dashboard/agents/* 未知子路由处理：
 * - 已迁移到 Space 的子设置页（acp/connect/platforms 等）一律直接 404；
 * - 其余（overview 等）→ /dashboard/spaces/<spaceId>/agents/<agentId>/...
 * - space 解析失败时回退 spaces 列表页。
 * 注意：使用必选 catch-all [...rest]，避免与同级 page.tsx
 * （/dashboard/agents/[id]）的 specificity 冲突。
 */
const REMOVED_SECTIONS = new Set([
  "acp",
  "automation",
  "computer",
  "connect",
  "gateway",
  "mcp",
  "platforms",
  "projects",
  "tool-calls",
  "web",
]);

export default function AgentsRemovedPage() {
  const params = useParams<{ id: string; rest: string[] }>();
  const router = useRouter();
  const removed =
    (params.rest?.length ?? 0) > 0 &&
    REMOVED_SECTIONS.has(params.rest![0]);

  useEffect(() => {
    if (removed) return;
    const agentId = params.id;
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const agent = await api<AgentListItem & { spaceId?: string }>(
          `/api/agents/${encodeURIComponent(agentId)}`,
        );
        if (cancelled) return;
        if (agent.spaceId) {
          router.replace(`/dashboard/spaces/${agent.spaceId}/agents/${agentId}`);
          return;
        }
      } catch {
        // fall through
      }
      if (!cancelled) router.replace("/dashboard/spaces");
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router, removed]);

  if (removed) notFound();
  return <PageLoading />;
}
