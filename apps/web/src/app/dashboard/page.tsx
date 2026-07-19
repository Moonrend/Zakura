"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Home → Agents (no generic "components" hub) */
export default function DashboardHome() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/agents");
  }, [router]);
  return null;
}
