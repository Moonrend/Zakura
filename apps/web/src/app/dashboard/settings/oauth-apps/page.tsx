"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";

/** 旧路径：统一迁到 OAuth 客户端页 */
export default function OauthAppsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/settings/oauth-clients");
  }, [router]);

  return <PageLoading />;
}
