"use client";

import { Check, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentListItem } from "@/lib/agents";
import { cn } from "@/lib/utils";

export type AgentTargetValue = {
  /** 安装到全部 Agent */
  all: boolean;
  /** all=false 时的选中列表 */
  agentIds: string[];
};

export function resolveAgentIds(
  value: AgentTargetValue,
  agents: AgentListItem[],
): string[] {
  if (value.all) return agents.map((a) => a.id);
  return value.agentIds;
}

/**
 * 安装目标选择：默认「全部 Agent」，点开可多选。
 * 用于 MCP / Skill 安装，避免再塞下拉框。
 */
export function AgentTargetPicker({
  agents,
  value,
  onChange,
  disabled,
  className,
}: {
  agents: AgentListItem[];
  value: AgentTargetValue;
  onChange: (next: AgentTargetValue) => void;
  disabled?: boolean;
  className?: string;
}) {
  const count = value.all ? agents.length : value.agentIds.length;

  function pickAll() {
    onChange({ all: true, agentIds: [] });
  }

  function toggle(id: string) {
    const set = new Set(value.all ? agents.map((a) => a.id) : value.agentIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const next = [...set];
    onChange({
      all: next.length === agents.length && agents.length > 0,
      agentIds: next.length === agents.length ? [] : next,
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" />
          安装到
        </span>
        <Button
          type="button"
          size="xs"
          variant={value.all ? "default" : "outline"}
          disabled={disabled || agents.length === 0}
          onClick={pickAll}
        >
          {value.all ? <Check className="size-3" /> : null}
          全部 Agent（{agents.length}）
        </Button>
        {!value.all ? (
          <span className="text-[11px] text-muted-foreground">
            已选 {count} 个
          </span>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">暂无 Agent，请先创建</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {agents.map((agent) => {
            const picked = value.all || value.agentIds.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                disabled={disabled}
                onClick={() => toggle(agent.id)}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                  picked
                    ? "border-foreground/30 bg-muted font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60",
                  disabled && "pointer-events-none opacity-50",
                )}
                title={agent.name}
              >
                {picked ? <Check className="size-3 shrink-0" /> : null}
                <span className="truncate">{agent.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
