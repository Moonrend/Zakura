"use client";

/**
 * Agent 设置 · 自动化
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { AutomationPanel } from "@/components/chat/automation-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { listAgentProjects } from "@/lib/agent-fs";

export default function AgentAutomationPage() {
  const router = useRouter();
  const { id, agent, loading } = useAgentDetail();
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listAgentProjects(id)
      .then((res) => {
        if (!cancelled) setProjects(res.projects.map((p) => p.name));
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading || !agent) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-64 w-full max-w-md rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="自动化"
        description="到点让 Agent 自己做事。也可在对话侧栏「任务」里管理。"
      />
      <div className="max-w-md overflow-hidden rounded-lg border border-border bg-card">
        <AutomationPanel
          agentId={id}
          projects={projects}
          className="max-h-[min(70vh,36rem)]"
          onAskAgentCreate={(goal) => {
            const prompt = [
              "请用 create_schedule 为我创建定时任务。",
              "根据下面描述自行决定名称、执行周期（cron 或 @every_…）和任务指令，创建后用一两句话确认。",
              "",
              goal.trim(),
            ].join("\n");
            try {
              sessionStorage.setItem("zakura_pending_prompt", prompt);
            } catch {
              /* ignore */
            }
            router.push(`/chat?agent=${id}`);
          }}
          onOpenSession={(sid) => {
            router.push(`/chat?agent=${id}&session=${sid}`);
          }}
        />
      </div>
    </div>
  );
}
