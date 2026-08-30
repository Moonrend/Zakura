"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 技能已移入 Agent 内部页面；保留路由兼容旧链接 */
export default function SkillsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/agents");
  }, [router]);
  return null;
}
