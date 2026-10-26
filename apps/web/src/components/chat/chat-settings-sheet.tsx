"use client";

import Link from "next/link";
import type { CloudAgentFollowUpMode } from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SettingsSaveIndicator } from "@/components/settings-shell";

export interface ChatSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName?: string;
  agentId: string | null;
  spaceId?: string | null;
  saveStatus: React.ComponentProps<typeof SettingsSaveIndicator>["status"];
  saveError: React.ComponentProps<typeof SettingsSaveIndicator>["error"];
  followUpMode: CloudAgentFollowUpMode;
  onFollowUpModeChange: (value: CloudAgentFollowUpMode) => void;
}

export function ChatSettingsSheet({ open, onOpenChange, agentName, agentId, spaceId, saveStatus, saveError, followUpMode, onFollowUpModeChange }: ChatSettingsSheetProps) {
  const base = agentId ? spaceId ? `/dashboard/spaces/${spaceId}/agents/${agentId}` : `/dashboard/agents/${agentId}` : null;
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent className="bg-background shadow-none sm:max-w-md">
      <SheetHeader><div className="flex items-start justify-between gap-2 pr-6"><SheetTitle>{agentName ?? "Agent"} 设置</SheetTitle><SettingsSaveIndicator status={saveStatus} error={saveError} /></div><SheetDescription className="sr-only">会话设置</SheetDescription></SheetHeader>
      <div className="space-y-4 py-4">
        <div className="flex items-center justify-between gap-4"><Label>执行中发消息</Label><Select value={followUpMode} onValueChange={value => { if (value === "steer" || value === "queue") onFollowUpModeChange(value); }} items={[{ value: "steer", label: "注入" }, { value: "queue", label: "排队" }]}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="steer">注入</SelectItem><SelectItem value="queue">排队</SelectItem></SelectContent></Select></div>
        {base ? <div className="flex gap-2"><Button variant="outline" size="sm" nativeButton={false} render={<Link href={`${base}/settings`} />}>Agent 设置</Button><Button variant="outline" size="sm" nativeButton={false} render={<Link href={`${base}/approvals`} />}>工具审批</Button></div> : null}
      </div>
    </SheetContent>
  </Sheet>;
}
