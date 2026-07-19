"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function McpStoreRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/mcp/store");
  }, [router]);
  return null;
}
