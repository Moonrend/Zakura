"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Route, Search } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";

export type ModelRouteSelectorItem = {
  value: string;
  label: string;
  /** 次要说明，通常是上游名；单提供商模型才会显示在主菜单行尾。 */
  hint?: string;
  keywords?: string[];
  reasoning?: boolean;
  reasoningLevels?: string[];
  defaultReasonLevel?: string;
  providers?: Array<{ id: string; name: string }>;
};

/** 模型名最重要，其次是 alias，再次是上游。 */
const FUZZY_KEYS = [
  { name: "label", weight: 3 },
  { name: "value", weight: 2 },
  { name: "keywords", weight: 1.5 },
  { name: "hint", weight: 1 },
];

/**
 * 统一模型选择器：主菜单选模型；多上游时子菜单选「自动」或具体提供商。
 */
export function ModelRouteSelector({
  items,
  value,
  routeId,
  onSelectionChange,
  disabled,
  placeholder = "模型",
  className,
  align = "start",
  side = "bottom",
}: {
  items: ModelRouteSelectorItem[];
  value?: string | null;
  routeId?: string | null;
  onSelectionChange?: (value: string | null, routeId: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useFuzzySearch(items, query, { keys: FUZZY_KEYS });
  const selected = useMemo(
    () => items.find((item) => item.value === value) ?? null,
    [items, value],
  );

  function selectModel(modelValue: string, modelRouteId: string | null) {
    onSelectionChange?.(modelValue, modelRouteId);
    setOpen(false);
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label="选择模型"
            className={cn(
              "inline-flex h-8 max-w-[13rem] min-w-0 items-center gap-1 rounded-full pr-1.5 pl-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none select-none",
              "transition-[background-color,color] duration-200 ease-fluid hover:bg-muted/70 hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              open && "bg-muted/70 text-foreground",
              className,
            )}
          />
        }
      >
        <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-55 transition-transform duration-300 ease-overshoot",
            open && "rotate-180",
          )}
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-auto min-w-48 max-w-[min(22rem,calc(100vw-1.5rem))]"
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="搜索模型…"
            aria-label="搜索模型"
            className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-[min(22rem,var(--available-height))] overflow-y-auto pt-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-5 text-center text-xs text-muted-foreground">
              没有匹配的模型
            </div>
          ) : (
            filtered.map((item) => {
              const providers = item.providers ?? [];
              const hasMultipleRoutes = providers.length > 1;

              if (!hasMultipleRoutes) {
                return (
                  <DropdownMenuItem
                    key={item.value}
                    onClick={() => selectModel(item.value, null)}
                    className="min-w-0 gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="max-w-32 shrink-0 truncate text-[11px] text-muted-foreground/70">
                        {item.hint}
                      </span>
                    ) : null}
                    {item.value === value && !routeId ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                );
              }

              return (
                <DropdownMenuSub key={item.value}>
                  <DropdownMenuSubTrigger className="min-w-0 gap-2">
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="text-[11px] text-muted-foreground/70">路由</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-44 max-w-[min(18rem,calc(100vw-1.5rem))]">
                    <DropdownMenuItem
                      onClick={() => selectModel(item.value, null)}
                      className="gap-2"
                    >
                      <Route className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block">自动</span>
                        <span className="block text-[11px] text-muted-foreground">
                          动态路由
                        </span>
                      </span>
                      {item.value === value && !routeId ? (
                        <Check className="size-3.5 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                    {providers.map((provider) => (
                      <DropdownMenuItem
                        key={provider.id}
                        onClick={() => selectModel(item.value, provider.id)}
                        className="gap-2"
                      >
                        <span className="size-1.5 shrink-0 rounded-full bg-foreground/45" />
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        {item.value === value && routeId === provider.id ? (
                          <Check className="size-3.5 shrink-0" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** @deprecated 使用 ModelRouteSelectorItem */
export type ModelPickerItem = ModelRouteSelectorItem;

/** @deprecated 使用 ModelRouteSelector */
export const ModelPicker = ModelRouteSelector;
