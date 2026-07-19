"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function AgentWebSearchRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/agents/${params.id}/web`);
  }, [params.id, router]);
  return null;
}
