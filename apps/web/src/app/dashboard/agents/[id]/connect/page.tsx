"use client";

import { useParams } from "next/navigation";
import { Cable, ShieldCheck } from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { AgentConnectPanel } from "@/components/agent-connect-panel";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentConnectPage() {
  const { id } = useParams<{ id: string }>();
  const { agent, loading } = useAgentDetail();

  if (loading) {
    return <div className="space-y-5"><Skeleton className="h-8 w-32" /><Skeleton className="h-96 w-full rounded-lg" /></div>;
  }
  if (!agent) return <p className="text-sm text-muted-foreground">Agent 不存在或无权访问。</p>;

  return (
    <div className="max-w-3xl space-y-5">
      <SettingsHeader
        title="接入"
        description="将此 Agent 作为 MCP 服务接入 Claude、Cursor、Codex 等支持远程 MCP 的客户端。"
      />
      <SettingsSection title="MCP 接入信息" description="地址和访问凭据用于连接此 Agent，请妥善保管。">
        <AgentConnectPanel agentId={id} agentSlug={agent.slug} mcpAgentUrl={agent.mcpAgentUrl} />
      </SettingsSection>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-4">
          <Cable className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div><p className="text-sm font-medium">远程 MCP</p><p className="mt-1 text-xs leading-5 text-muted-foreground">使用 Streamable HTTP，客户端只需填写 URL 与 Bearer Key。</p></div>
        </div>
        <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div><p className="text-sm font-medium">按 Agent 授权</p><p className="mt-1 text-xs leading-5 text-muted-foreground">生成的 Key 仅能访问当前 Agent，撤销后立即失效。</p></div>
        </div>
      </div>
    </div>
  );
}
