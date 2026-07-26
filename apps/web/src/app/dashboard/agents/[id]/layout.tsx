"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, KeyRound, Trash2 } from "lucide-react";
import { AGENT_SUBNAV } from "@/lib/agents";
import { api } from "@/lib/api";
import {
  AgentDetailProvider,
  useAgentDetail,
} from "@/components/agent-detail-context";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

function AgentSettingsChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { id, agent, list } = useAgentDetail();

  const activeSeg =
    AGENT_SUBNAV.find((s) => pathname.endsWith(`/${s.href}`))?.href ?? "chat";
  const pageLabel =
    AGENT_SUBNAV.find((s) => s.href === activeSeg)?.label ?? "设置";

  async function remove() {
    if (!agent) return;
    if (!confirm(`删除 ${agent.name}？`)) return;
    const purge = confirm("同时清除工作区数据？");
    try {
      await api(`/api/agents/${id}?purge=${purge ? "1" : "0"}`, { method: "DELETE" });
      router.replace("/dashboard/agents");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function mintKey() {
    try {
      const res = await api<{ rawKey: string }>(`/api/agents/${id}/keys`, {
        method: "POST",
        json: {},
      });
      await navigator.clipboard.writeText(res.rawKey);
      toast.success("API Key 已复制");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-h-[calc(100svh-5.5rem)] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/80 pb-3">
        <Button nativeButton={false} render={<Link href="/dashboard/agents" />}>
          <ChevronLeft className="h-4 w-4" />
          Agents
        </Button>

        <Select
          value={id}
          onValueChange={(v) => {
            if (v) router.push(`/dashboard/agents/${v}/${activeSeg}`);
          }}
          items={list.map((a) => ({ value: a.id, label: a.name }))}
        >
          <SelectTrigger className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {list.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!agent ? (
          <Skeleton className="h-5 w-16" />
        ) : (
          <span className="text-sm text-muted-foreground">{pageLabel}</span>
        )}

        <div className="ml-auto flex flex-wrap gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="icon-sm" variant="outline" onClick={() => void mintKey()} />
              }
            >
              <KeyRound />
            </TooltipTrigger>
            <TooltipContent>签发 API Key</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="destructive"
                  onClick={() => void remove()}
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipContent>删除</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export default function AgentSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <AgentDetailProvider key={id} id={id}>
      <AgentSettingsChrome>{children}</AgentSettingsChrome>
    </AgentDetailProvider>
  );
}
