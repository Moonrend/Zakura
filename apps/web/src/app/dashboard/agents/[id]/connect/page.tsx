"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** @deprecated 接入已并入概况页；保留兼容旧链接 */
export default function AgentConnectRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/overview#access`);
  }, [params.id, router]);
  return null;
}
