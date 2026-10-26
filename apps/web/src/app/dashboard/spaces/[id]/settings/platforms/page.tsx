"use client";

import { useEffect, useState } from "react";
import { AgentPlatformsPanel } from "@/components/agent-platforms-panel";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { SettingsHeader } from "@/components/settings-shell";
import { fetchAgents } from "@/lib/agents";

export default function SpacePlatformsPage() {
  const { spaceId } = useSpaceSettings();
  const [members, setMembers] = useState<{ spaceId: string; agents: { id: string; name: string }[] }>({ spaceId: "", agents: [] });
  const [loadError, setLoadError] = useState<{ spaceId: string; message: string } | null>(null);

  useEffect(() => {
    let current = true;
    fetchAgents().then((agents) => {
      if (!current) return;
      setMembers({ spaceId, agents: agents.filter((agent) => agent.spaceId === spaceId).map(({ id, name }) => ({ id, name })) });
      setLoadError(null);
    }).catch(() => {
      if (current) setLoadError({ spaceId, message: "未能加载空间成员，请刷新后重试。渠道设置仍可保存。" });
    });
    return () => { current = false; };
  }, [spaceId]);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="消息平台"
        description="渠道保存在这个空间里，只存一份。每条渠道指定由哪个 Agent 回复。"
      />
      {loadError?.spaceId === spaceId && <p role="status" className="text-sm text-muted-foreground">{loadError.message}</p>}
      <AgentPlatformsPanel
        spaceId={spaceId}
        memberAgents={members.spaceId === spaceId ? members.agents : []}
      />
    </div>
  );
}
