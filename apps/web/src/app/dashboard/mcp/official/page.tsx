"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

/** 官方商店已并入 /dashboard/mcp/store */
export default function McpOfficialStoreRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/mcp/store");
  }, [router]);
  return <Skeleton className="h-48 w-full rounded-lg" />;
}
