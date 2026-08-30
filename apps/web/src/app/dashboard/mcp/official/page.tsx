"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";

/** 官方商店已并入 /dashboard/mcp/store */
export default function McpOfficialStoreRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/mcp/store");
  }, [router]);
  return <PageLoading />;
}
