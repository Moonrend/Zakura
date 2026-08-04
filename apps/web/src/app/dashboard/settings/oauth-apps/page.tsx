"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

/** 旧路径：统一迁到 OAuth 客户端页 */
export default function OauthAppsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/settings/oauth-clients");
  }, [router]);

  return <Skeleton className="h-48 w-full rounded-lg" />;
}
