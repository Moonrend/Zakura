"use client";

import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentPlatformsPanel } from "@/components/agent-platforms-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentPlatformsPage() {
  const { id, agent } = useAgentDetail();

  if (!agent) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="消息平台"
        description={
          <>
            通过 Chat SDK 添加消息连接器；每个实例凭据独立，同一平台可添加多个。邮箱工具（Amail /
            Bettermail）请到{" "}
            <a
              href="/dashboard/connectors"
              className="underline underline-offset-2 hover:text-foreground"
            >
              连接器
            </a>
            。
          </>
        }
      />
      <AgentPlatformsPanel agentId={id} />
    </div>
  );
}
