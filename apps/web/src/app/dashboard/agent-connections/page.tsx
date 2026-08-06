"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
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
          router.replace(`/dashboard/agents/${agents[0].id}/platforms`);
        } else {
          router.replace("/dashboard/agents");
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/dashboard/agents");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      正在跳转…
    </div>
  );
}
