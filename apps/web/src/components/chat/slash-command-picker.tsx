"use client";

import { Blocks, SquareTerminal } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ComposerSlashItem } from "@/lib/composer-slash";

export function SlashCommandPicker({
  items,
  activeIndex,
  onHover,
  onSelect,
}: {
  items: readonly ComposerSlashItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: ComposerSlashItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-sm">
        没有匹配的命令
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="斜杠命令"
      className="overflow-hidden rounded-lg border border-border bg-popover shadow-sm"
    >
      <div className="max-h-[min(16rem,40vh)] overflow-y-auto p-1">
        {items.map((item, index) => {
          const Icon = item.kind === "skill" ? Blocks : SquareTerminal;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                index === activeIndex ? "bg-muted text-foreground" : "text-foreground/90",
              )}
            >
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px]">/{item.name}</span>
                {item.description ? (
                  <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
