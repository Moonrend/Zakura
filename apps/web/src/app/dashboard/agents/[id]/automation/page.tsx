"use client";

/**
 * Agent 设置 · 自动化
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { AutomationPanel } from "@/components/chat/automation-panel";
import { PageLoading } from "@/components/ui/progress-linear";
import { listAgentProjects } from "@/lib/agent-fs";

export default function AgentAutomationPage() {
  const router = useRouter();
  const { id, agent, loading } = useAgentDetail();
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listAgentProjects(id)
      .then((res) => {
        if (!cancelled) setProjects(res.projects.map((p) => p.slug));
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading || !agent) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="自动化"
        description="定时与事件任务（Routine）"
      />
      <div className="max-w-md overflow-hidden rounded-lg bg-card shadow-surface-2">
        <AutomationPanel
          agentId={id}
          projects={projects}
          className="max-h-[min(70vh,36rem)]"
          onAskAgentCreate={(goal) => {
            const prompt = [
              "请用 create_routine 为我创建定时或事件任务（Routine）。",
              "根据下面描述自行决定名称、触发方式（cron 或 listener）和任务意图，创建后用一两句话确认。",
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
