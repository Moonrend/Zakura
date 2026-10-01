"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function SpaceSettingsIndexPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/dashboard/spaces/${params.id}/settings/platforms`);
  }, [params.id, router]);
  return null;
}
