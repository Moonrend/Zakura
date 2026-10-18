"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { SpaceAccessPanel } from "@/components/space-access-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";
import { fetchSpace, type SpaceItem } from "@/lib/spaces";

function SpaceConnectPageContent() {
  const { spaceId } = useSpaceSettings();
  const searchParams = useSearchParams();
  const [space, setSpace] = useState<SpaceItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSpace(null);
    setError(null);
    void fetchSpace(spaceId)
      .then((row) => {
        if (!cancelled) setSpace(row);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (error) return <p className="text-sm text-muted-foreground">空间不存在或无权访问。</p>;
  if (!space) return <PageLoading />;

  return (
    <div className="space-y-6">
      <SettingsHeader title="接入" description="在外部客户端中使用当前空间的工具和模型。" />
      <SpaceAccessPanel
        key={space.id}
        space={space}
        initialProtocol={searchParams.get("tab") === "gateway" ? "gateway" : "mcp"}
      />
    </div>
  );
}

export default function SpaceConnectPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SpaceConnectPageContent />
    </Suspense>
  );
}
