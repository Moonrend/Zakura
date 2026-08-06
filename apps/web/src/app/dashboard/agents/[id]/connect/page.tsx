"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** 保留旧链接，统一转到 Agent 的 Gateway 页面。 */
export default function AgentConnectRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/gateway`);
  }, [params.id, router]);
  return null;
}
