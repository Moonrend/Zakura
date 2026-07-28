"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { AgentConnectPanel } from "@/components/agent-connect-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";

type Props = {
  agent: {
    id: string;
    name: string;
    slug: string;
    mcpAgentUrl: string;
  };
  busy?: boolean;
  onBack: () => void;
  onConfigured: () => void;
  nextLabel: string;
  onContinue: () => void;
};

export function StepAgentConnect({
  agent,
  busy,
  onBack,
  onConfigured,
  nextLabel,
  onContinue,
}: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        disabled={busy}
        onClick={onBack}
      >
        <ArrowLeft />
        返回添加 MCP
      </Button>

      <SettingsHeader
        title="接入代理工具"
        description={`将 ${agent.name} 作为标准 MCP 服务接入其他代理或自动化系统。`}
      />

      <AgentConnectPanel
        agentId={agent.id}
        agentSlug={agent.slug}
        mcpAgentUrl={agent.mcpAgentUrl}
        compact
        disabled={busy}
        onConfigured={() => {
          setCopied(true);
          onConfigured();
        }}
      />

      <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-border/80 pt-4 sm:flex-row sm:items-center">
        <p className="text-center text-xs text-muted-foreground sm:text-left">

        </p>
        <Button disabled={busy} onClick={onContinue}>
          {nextLabel}
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
