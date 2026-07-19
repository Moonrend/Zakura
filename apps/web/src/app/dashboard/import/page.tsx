"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function McpImportRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/mcp/import");
  }, [router]);
  return null;
}
