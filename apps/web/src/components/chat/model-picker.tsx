"use client";

import { useEffect, useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useFuzzySearch } from "@/hooks/use-fuzzy-search";

export type ModelPickerItem = {
  value: string;
  label: string;
  /** 次要说明，通常是上游名；在行尾以浅色显示 */
  hint?: string;
  keywords?: string[];
  reasoning?: boolean;
  reasoningLevels?: string[];
  defaultReasonLevel?: string;
};

/** 模型名最重要，其次是 alias，再次是上游 */
const FUZZY_KEYS = [
  { name: "label", weight: 3 },
  { name: "value", weight: 2 },
  { name: "keywords", weight: 1.5 },
  { name: "hint", weight: 1 },
];

/**
 * 输入框里的模型选择器。
 *
 * 触发器是一枚无边框的药丸（只有名字和箭头），不跟输入框抢注意力；
 * 展开后向上弹出，行内同时给出模型名与上游。
 * 过滤走 Fuse 模糊匹配：`gpt4o` 也能找到 `gpt-4o`，同时保留子串命中兜底。
 */
export function ModelPicker({
  items,
  value,
  onValueChange,
  disabled,
  placeholder = "模型",
  className,
}: {
  items: ModelPickerItem[];
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => items.find((i) => i.value === value) ?? null,
    [items, value],
  );
  const filtered = useFuzzySearch(items, query, { keys: FUZZY_KEYS });

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <Combobox.Root
      items={filtered}
      value={selected}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(item) => {
        onValueChange?.(item?.value ?? null);
        setOpen(false);
        setQuery("");
      }}
      itemToStringLabel={(item) => item?.label ?? ""}
      isItemEqualToValue={(a, b) => a?.value === b?.value}
      disabled={disabled}
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
    >
      <Combobox.Trigger
        disabled={disabled}
        aria-label="选择模型"
        className={cn(
          "inline-flex h-8 max-w-[13rem] min-w-0 items-center gap-1 rounded-full pr-1.5 pl-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none select-none",
          "transition-[background-color,color] duration-200 ease-fluid hover:bg-muted/70 hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-50",
          open && "bg-muted/70 text-foreground",
          className,
        )}
      >
        <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-55 transition-transform duration-300 ease-overshoot",
            open && "rotate-180",
          )}
        />
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner
          className="z-[60] outline-none"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Combobox.Popup
            className={cn(
              "flex max-h-[min(22rem,var(--available-height))] w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-soft)]",
              "origin-[var(--transform-origin)] transition-[transform,scale,opacity] duration-200 ease-out-soft",
              "data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input
                className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder="搜索模型…"
                autoFocus
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {/*
                Base UI 要求 Empty 常驻 DOM（它是 aria-live 区域），只把 children 置空。
                所以留白必须放在子节点上，否则有结果时顶上会多出一条空条。
              */}
              <Combobox.Empty>
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  没有匹配的模型
                </div>
              </Combobox.Empty>
              <Combobox.List>
                {(item: ModelPickerItem) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none select-none",
                      "transition-colors duration-100",
                      "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                      "data-selected:font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="max-w-28 shrink-0 truncate font-mono text-[10.5px] text-muted-foreground/70">
                        {item.hint}
                      </span>
                    ) : null}
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <Combobox.ItemIndicator>
                        <Check className="size-3.5" />
                      </Combobox.ItemIndicator>
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
