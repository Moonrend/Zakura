"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";
import { api } from "@/lib/api";
import type { AgentListItem } from "@/lib/agents";

/**
 * 旧 /dashboard/agents/* 未知子路由迁移：
 * - 子设置页（acp/connect/platforms 等）→ 所属 space 的设置页
 * - 其余（overview 等）→ /dashboard/spaces/<spaceId>/agents/<agentId>/...
 * - space 解析失败时回退 spaces 列表页。
 * 注意：使用必选 catch-all [...rest]，避免与同级 page.tsx
 * （/dashboard/agents/[id]）的 specificity 冲突。
 */
const MOVED_TO_SPACE = new Set([
  "acp",
  "automation",
  "computer",
  "connect",
  "gateway",
  "mcp",
  "platforms",
  "projects",
  "tool-calls",
]);

export default function AgentsRedirectPage() {
  const params = useParams<{ id: string; rest: string[] }>();
  const router = useRouter();

  useEffect(() => {
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
          const rest = params.rest ?? [];
          if (rest.length > 0 && MOVED_TO_SPACE.has(rest[0])) {
            router.replace(
              `/dashboard/spaces/${agent.spaceId}/settings/${rest.join("/")}`,
            );
          } else {
            router.replace(`/dashboard/spaces/${agent.spaceId}/agents/${agentId}`);
          }
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
  }, [params, router]);

  return <PageLoading />;
}
