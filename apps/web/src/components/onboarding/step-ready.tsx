"use client";

import { ArrowRight, Bot, Boxes, Loader2 } from "lucide-react";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";

type ReadyAgent = {
  id: string;
  name: string;
};

type Props = {
  agent: ReadyAgent;
  hasChatModel: boolean;
  busy?: boolean;
  onAddMcp: () => void;
  onUseCloudAgent: () => void;
  onSkip: () => void;
};

export function StepReady({
  agent,
  hasChatModel,
  busy,
  onAddMcp,
  onUseCloudAgent,
  onSkip,
}: Props) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <SettingsHeader title="开始使用" />

      <div className="onboarding-choice-enter overflow-hidden rounded-lg border border-border bg-card sm:grid sm:grid-cols-2 sm:divide-x sm:divide-border">
        <button
          type="button"
          className="group flex min-h-44 w-full flex-col p-5 text-left surface-interactive focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onAddMcp}
        >
          <Boxes className="size-5 text-muted-foreground" aria-hidden="true" />
          <span className="mt-5 text-sm font-medium">为其他代理扩展能力</span>
          <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            接入上游 MCP，让 Agent 使用更多工具
          </span>
          <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-medium">
            添加 MCP
            <ArrowRight className="size-3.5" />
          </span>
        </button>

        <button
          type="button"
          className="group flex min-h-44 w-full flex-col border-t border-border p-5 text-left surface-interactive focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:border-t-0"
          onClick={onUseCloudAgent}
          disabled={busy}
        >
          <Bot className="size-5 text-muted-foreground" aria-hidden="true" />
          <span className="mt-5 text-sm font-medium">使用云端 Agent</span>
          <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {hasChatModel
              ? "AI 已连接，打开即可对话"
              : "连接提供商，在网页中直接对话"}
          </span>
          <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-medium">
            {hasChatModel ? "打开示例对话" : "下一步：配置 AI"}
            <ArrowRight className="size-3.5" />
          </span>
        </button>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" disabled={busy} onClick={onSkip}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          稍后设置
        </Button>
      </div>
    </div>
  );
}
