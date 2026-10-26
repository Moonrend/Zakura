"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { PageLoading } from "@/components/ui/progress-linear";

export default function SpaceGatewayPage() {
  const { spaceId } = useSpaceSettings();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/dashboard/spaces/${spaceId}/settings/connect?tab=gateway`);
  }, [router, spaceId]);

  return <PageLoading />;
}
