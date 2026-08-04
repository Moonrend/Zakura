"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

/** 统一连接中心已拆回 MCP / Skills / 凭据独立入口 */
function ConnectionsRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const tab = searchParams.get("tab");
    const source = searchParams.get("source") ?? "";
    if (tab === "credentials") {
      router.replace("/dashboard/settings/oauth-clients");
      return;
    }
    if (tab === "store") {
      if (
        source.startsWith("skill") ||
        source.includes("claude") ||
        source.includes("codex") ||
        source.includes("plugin") ||
        source.includes("openai")
      ) {
        router.replace("/dashboard/skills");
        return;
      }
      if (source.includes("official") || source === "mcp-official") {
        router.replace("/dashboard/mcp/store");
        return;
      }
      router.replace("/dashboard/mcp/store?tab=community");
      return;
    }
    // 旧「统一连接中心」默认入口 → 平台连接器（MCP 请走 /dashboard/mcp）
    router.replace("/dashboard/connectors");
  }, [router, searchParams]);

  return <Skeleton className="h-48 w-full rounded-lg" />;
}

export default function LegacyConnectionsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
      <ConnectionsRedirectInner />
    </Suspense>
  );
}
