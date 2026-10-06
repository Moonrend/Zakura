"use client";

import { useEffect, useState } from "react";
import { Cable, ShieldCheck } from "lucide-react";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { SpaceConnectPanel } from "@/components/space-connect-panel";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";
import { fetchSpace, type SpaceItem } from "@/lib/spaces";

export default function SpaceConnectPage() {
  const { spaceId } = useSpaceSettings();
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
    <div className="max-w-3xl space-y-5">
      <SettingsHeader
        title="接入"
        description="作为远程 MCP 服务接入外部客户端"
      />
      <SettingsSection title="MCP 接入信息">
        <SpaceConnectPanel
          spaceId={space.id}
          spaceSlug={space.slug}
          spaceName={space.name}
          mcpUrl={space.mcpUrl}
        />
      </SettingsSection>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-4">
          <Cable className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div><p className="text-sm font-medium">远程 MCP</p><p className="mt-1 text-xs leading-5 text-muted-foreground">使用 Streamable HTTP，客户端只需填写 URL 与 Bearer Key。</p></div>
        </div>
        <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div><p className="text-sm font-medium">按空间授权</p><p className="mt-1 text-xs leading-5 text-muted-foreground">生成的 Key 可访问该空间内所有 Agent 共享的 MCP 工具，撤销后立即失效。</p></div>
        </div>
      </div>
    </div>
  );
}
