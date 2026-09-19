"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { CloudAgentFollowUpMode, ToolApprovalPolicy } from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettingsRow, SettingsSaveIndicator } from "@/components/settings-shell";

/** 会话内快捷设置。完整分类见 Agent 设置页 */
export interface ChatSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName?: string;
  agentId: string | null;
  saveStatus: React.ComponentProps<typeof SettingsSaveIndicator>["status"];
  saveError: React.ComponentProps<typeof SettingsSaveIndicator>["error"];
  systemPrompt: string;
  onSystemPromptChange: (value: string) => void;
  enableTools: boolean;
  onEnableToolsChange: (value: boolean) => void;
  autoMemory: boolean;
  onAutoMemoryChange: (value: boolean) => void;
  autoTitle: boolean;
  onAutoTitleChange: (value: boolean) => void;
  followUpMode: CloudAgentFollowUpMode;
  onFollowUpModeChange: (value: CloudAgentFollowUpMode) => void;
  approvalPolicy: ToolApprovalPolicy;
  onApprovalPolicyChange: (value: ToolApprovalPolicy) => void;
  maxSubagentDepth: string;
  onMaxSubagentDepthChange: (value: string) => void;
}

const SUBAGENT_DEPTHS = ["1", "2", "3", "4", "5"] as const;

const APPROVAL_POLICIES: Array<{ value: ToolApprovalPolicy; label: string; hint: string }> = [
  { value: "allow_all", label: "自动允许", hint: "所有工具调用直接执行" },
  { value: "ask", label: "每次询问", hint: "只读放行，其余等你确认" },
  { value: "ai", label: "AI 审批", hint: "AI 门控决定，低置信度转人工" },
];

function approvalPolicyHint(policy: ToolApprovalPolicy): string {
  return APPROVAL_POLICIES.find((p) => p.value === policy)?.hint ?? "";
}

export function ChatSettingsSheet({
  open,
  onOpenChange,
  agentName,
  agentId,
  saveStatus,
  saveError,
  systemPrompt,
  onSystemPromptChange,
  enableTools,
  onEnableToolsChange,
  autoMemory,
  onAutoMemoryChange,
  autoTitle,
  onAutoTitleChange,
  followUpMode,
  onFollowUpModeChange,
  approvalPolicy,
  onApprovalPolicyChange,
  maxSubagentDepth,
  onMaxSubagentDepthChange,
}: ChatSettingsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-background shadow-none sm:max-w-md">
        <SheetHeader>
          <div className="flex items-start justify-between gap-2 pr-6">
            <SheetTitle>{agentName ?? "Agent"} 设置</SheetTitle>
            <SettingsSaveIndicator status={saveStatus} error={saveError} />
          </div>
          <SheetDescription className="sr-only">Agent 设置</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="mt-4 space-y-1 px-1 pb-6">
            <div className="space-y-2 pb-3">
              <Label htmlFor="chat-system">系统提示词</Label>
              <Textarea
                id="chat-system"
                value={systemPrompt}
                onChange={(e) => onSystemPromptChange(e.target.value)}
                className="min-h-28"
              />
            </div>
            <SettingsRow label="工具调用">
              <Switch checked={enableTools} onCheckedChange={onEnableToolsChange} />
            </SettingsRow>
            <SettingsRow label="自动记忆">
              <Switch checked={autoMemory} onCheckedChange={onAutoMemoryChange} />
            </SettingsRow>
            <SettingsRow label="自动标题">
              <Switch checked={autoTitle} onCheckedChange={onAutoTitleChange} />
            </SettingsRow>
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <Label>工具审批</Label>
                <p className="text-xs text-muted-foreground">
                  {approvalPolicyHint(approvalPolicy)}
                </p>
              </div>
              <Select
                value={approvalPolicy}
                onValueChange={(v) => {
                  if (v !== "allow_all" && v !== "ask" && v !== "ai") return;
                  onApprovalPolicyChange(v);
                }}
                items={APPROVAL_POLICIES.map((p) => ({ value: p.value, label: p.label }))}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPROVAL_POLICIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <Label>执行中发消息</Label>
                <p className="text-xs text-muted-foreground">
                  {followUpMode === "steer" ? "下一工具后注入" : "结束后按序发送"}
                </p>
              </div>
              <Select
                value={followUpMode}
                onValueChange={(v) => {
                  if (v !== "steer" && v !== "queue") return;
                  onFollowUpModeChange(v);
                }}
                items={[
                  { value: "steer", label: "注入" },
                  { value: "queue", label: "排队" },
                ]}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="steer">注入</SelectItem>
                  <SelectItem value="queue">排队</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <Label>子代理深度</Label>
              <Select
                value={maxSubagentDepth}
                onValueChange={(v) => {
                  if (v == null) return;
                  onMaxSubagentDepthChange(v);
                }}
                items={SUBAGENT_DEPTHS.map((value) => ({ value, label: value }))}
              >
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUBAGENT_DEPTHS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {agentId ? (
              <Button
                variant="ghost"
                className="mt-2 w-full"
                nativeButton={false}
                render={<Link href={`/dashboard/agents/${agentId}/overview`} />}
              >
                全部设置
                <ExternalLink className="size-3.5 opacity-70" />
              </Button>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}