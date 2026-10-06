"use client";

import { Boxes, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SpaceItem } from "@/lib/spaces";
import { cn } from "@/lib/utils";

export type SpaceTargetValue = {
  /** 安装到全部空间 */
  all: boolean;
  /** all=false 时的选中列表 */
  spaceIds: string[];
};

export function resolveSpaceIds(
  value: SpaceTargetValue,
  spaces: SpaceItem[],
): string[] {
  if (value.all) return spaces.map((s) => s.id);
  return value.spaceIds;
}

/**
 * 安装目标选择：默认「全部空间」，点开可多选。
 * 用于 MCP 安装，避免再塞下拉框。
 */
export function SpaceTargetPicker({
  spaces,
  value,
  onChange,
  disabled,
  className,
}: {
  spaces: SpaceItem[];
  value: SpaceTargetValue;
  onChange: (next: SpaceTargetValue) => void;
  disabled?: boolean;
  className?: string;
}) {
  const count = value.all ? spaces.length : value.spaceIds.length;

  function pickAll() {
    onChange({ all: true, spaceIds: [] });
  }

  function toggle(id: string) {
    const set = new Set(value.all ? spaces.map((s) => s.id) : value.spaceIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const next = [...set];
    onChange({
      all: next.length === spaces.length && spaces.length > 0,
      spaceIds: next.length === spaces.length ? [] : next,
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Boxes className="size-3.5" />
          安装到
        </span>
        <Button
          type="button"
          size="xs"
          variant={value.all ? "default" : "outline"}
          disabled={disabled || spaces.length === 0}
          onClick={pickAll}
        >
          {value.all ? <Check className="size-3" /> : null}
          全部空间（{spaces.length}）
        </Button>
        {!value.all ? (
          <span className="text-[11px] text-muted-foreground">
            已选 {count} 个
          </span>
        ) : null}
      </div>

      {spaces.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">暂无空间，请先创建</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {spaces.map((space) => {
            const picked = value.all || value.spaceIds.includes(space.id);
            return (
              <button
                key={space.id}
                type="button"
                disabled={disabled}
                onClick={() => toggle(space.id)}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                  picked
                    ? "border-foreground/30 bg-muted font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60",
                  disabled && "pointer-events-none opacity-50",
                )}
                title={space.name}
              >
                {picked ? <Check className="size-3 shrink-0" /> : null}
                <span className="truncate">{space.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
