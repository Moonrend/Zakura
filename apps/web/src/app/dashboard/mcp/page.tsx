"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** MCP 列表已移入 Agent 内部页面；保留路由兼容旧链接 */
export default function McpRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/agents");
  }, [router]);
  return null;
}
