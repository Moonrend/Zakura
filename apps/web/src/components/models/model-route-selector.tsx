"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Route, Search } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";
import { useIsMobile } from "@/hooks/use-mobile";

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

const triggerClassName = (open: boolean, className?: string) =>
  cn(
    "inline-flex h-8 max-w-[13rem] min-w-0 items-center gap-1 rounded-full pr-1.5 pl-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none select-none",
    "transition-[background-color,color] duration-200 ease-fluid hover:bg-muted/70 hover:text-foreground",
    "focus-visible:ring-2 focus-visible:ring-ring/50",
    "disabled:pointer-events-none disabled:opacity-50",
    open && "bg-muted/70 text-foreground",
    className,
  );

/**
 * 统一模型选择器：主菜单选模型；多上游时子菜单选「自动」或具体提供商。
 * 手机端改用底部 Sheet + 页内展开路由，避免 Dropdown 子菜单在触摸设备上无法点选。
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
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = useFuzzySearch(items, query, { keys: FUZZY_KEYS });
  const selected = useMemo(
    () => items.find((item) => item.value === value) ?? null,
    [items, value],
  );

  function closePicker() {
    setOpen(false);
    setQuery("");
    setExpanded(null);
  }

  function selectModel(modelValue: string, modelRouteId: string | null) {
    onSelectionChange?.(modelValue, modelRouteId);
    closePicker();
  }

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setExpanded(null);
    }
  }

  const triggerLabel = selected?.label ?? placeholder;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <button
          type="button"
          disabled={disabled}
          aria-label="选择模型"
          aria-expanded={open}
          aria-haspopup="dialog"
          className={triggerClassName(open, className)}
          onClick={() => setOpen(true)}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 opacity-55 transition-transform duration-300 ease-overshoot",
              open && "rotate-180",
            )}
          />
        </button>

        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[min(85dvh,36rem)] gap-0 rounded-t-2xl p-0"
        >
          <SheetHeader className="border-b border-border/70 px-4 py-3">
            <SheetTitle>选择模型</SheetTitle>
          </SheetHeader>

          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型…"
              aria-label="搜索模型"
              autoFocus
              className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {filtered.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                没有匹配的模型
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((item) => {
                  const providers = item.providers ?? [];
                  const hasMultipleRoutes = providers.length > 1;
                  const isExpanded = expanded === item.value;
                  const isSelectedModel = item.value === value;

                  if (!hasMultipleRoutes) {
                    return (
                      <li key={item.value}>
                        <button
                          type="button"
                          className={cn(
                            "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm",
                            "hover:bg-muted/70 active:bg-muted",
                            isSelectedModel && !routeId && "bg-muted/60",
                          )}
                          onClick={() => selectModel(item.value, null)}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {item.label}
                          </span>
                          {item.hint ? (
                            <span className="max-w-32 shrink-0 truncate text-[11px] text-muted-foreground/70">
                              {item.hint}
                            </span>
                          ) : null}
                          {isSelectedModel && !routeId ? (
                            <Check className="size-4 shrink-0" />
                          ) : null}
                        </button>
                      </li>
                    );
                  }

                  return (
                    <li key={item.value} className="rounded-lg">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        className={cn(
                          "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm",
                          "hover:bg-muted/70 active:bg-muted",
                          isSelectedModel && "bg-muted/40",
                        )}
                        onClick={() =>
                          setExpanded((current) =>
                            current === item.value ? null : item.value,
                          )
                        }
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {item.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">路由</span>
                        <ChevronRight
                          className={cn(
                            "size-4 shrink-0 opacity-55 transition-transform duration-200",
                            isExpanded && "rotate-90",
                          )}
                        />
                      </button>
                      {isExpanded ? (
                        <ul className="mb-1 ml-2 flex flex-col gap-0.5 border-l border-border/60 pl-2">
                          <li>
                            <button
                              type="button"
                              className={cn(
                                "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm",
                                "hover:bg-muted/70 active:bg-muted",
                                isSelectedModel && !routeId && "bg-muted/60",
                              )}
                              onClick={() => selectModel(item.value, null)}
                            >
                              <Route className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <span className="block">自动</span>
                                <span className="block text-[11px] text-muted-foreground">
                                  动态路由
                                </span>
                              </span>
                              {isSelectedModel && !routeId ? (
                                <Check className="size-4 shrink-0" />
                              ) : null}
                            </button>
                          </li>
                          {providers.map((provider) => (
                            <li key={provider.id}>
                              <button
                                type="button"
                                className={cn(
                                  "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm",
                                  "hover:bg-muted/70 active:bg-muted",
                                  isSelectedModel &&
                                    routeId === provider.id &&
                                    "bg-muted/60",
                                )}
                                onClick={() =>
                                  selectModel(item.value, provider.id)
                                }
                              >
                                <span className="size-1.5 shrink-0 rounded-full bg-foreground/45" />
                                <span className="min-w-0 flex-1 truncate">
                                  {provider.name}
                                </span>
                                {isSelectedModel && routeId === provider.id ? (
                                  <Check className="size-4 shrink-0" />
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label="选择模型"
            className={triggerClassName(open, className)}
          />
        }
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
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
