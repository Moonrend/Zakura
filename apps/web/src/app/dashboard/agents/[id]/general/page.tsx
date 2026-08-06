"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** @deprecated 使用 /settings；保留兼容旧链接 */
export default function AgentGeneralRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/settings`);
  }, [params.id, router]);
  return null;
}
