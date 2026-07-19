"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** @deprecated 接入已迁至 /dashboard/agents/[id]/connect */
export default function AgentsConnectRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/agents");
  }, [router]);
  return <div className="text-sm text-muted-foreground">正在跳转…</div>;
}
