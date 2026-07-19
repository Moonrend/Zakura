"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** 旧「文件」入口 → 「电脑」 */
export default function AgentFilesRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/computer`);
  }, [params.id, router]);
  return null;
}
