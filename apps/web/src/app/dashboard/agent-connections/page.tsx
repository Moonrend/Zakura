"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";
import { fetchAgents } from "@/lib/agents";

/** 旧入口：跳转到某个 Agent 的平台子页 */
export default function AgentConnectionsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void fetchAgents()
      .then((agents) => {
        if (cancelled) return;
        if (agents[0]) {
          const first = agents[0];
          if (first.spaceId) {
            router.replace(
              `/dashboard/spaces/${first.spaceId}/settings/platforms`,
            );
          } else {
            router.replace(`/dashboard/agents/${first.id}`);
          }
        } else {
          router.replace("/dashboard/spaces");
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/dashboard/spaces");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <PageLoading />;
}
