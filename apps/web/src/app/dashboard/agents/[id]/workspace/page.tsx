"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** 旧「工作区」入口 → 「电脑」 */
export default function AgentWorkspaceRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/computer`);
  }, [params.id, router]);
  return null;
}
