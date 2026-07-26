"use client";

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchableSelectItem = {
  value: string;
  label: string;
  keywords?: string[];
};

type SearchableSelectProps = {
  items: SearchableSelectItem[];
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
};

function itemMatches(item: SearchableSelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.label.toLowerCase().includes(q)) return true;
  if (item.value.toLowerCase().includes(q)) return true;
  return (item.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

/**
 * 外观像 Select 的可搜索下拉：触发器为按钮，搜索框在弹出层内。
 */
export function SearchableSelect({
  items,
  value,
  onValueChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  disabled,
  className,
  triggerClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const selected = React.useMemo(
    () => items.find((i) => i.value === value) ?? null,
    [items, value],
  );

  const filtered = React.useMemo(
    () => items.filter((i) => itemMatches(i, query)),
    [items, query],
  );

  React.useEffect(() => {
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
      onInputValueChange={(v) => setQuery(v)}
    >
      <div className={cn("relative w-full", className)}>
        <Combobox.Trigger
          disabled={disabled}
          className={cn(
            "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            !selected && "text-muted-foreground",
            triggerClassName,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selected?.label ?? placeholder}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Combobox.Trigger>
      </div>

      <Combobox.Portal>
        <Combobox.Positioner className="z-[60] outline-none" sideOffset={4}>
          <Combobox.Popup
            className={cn(
              "flex w-[var(--anchor-width)] min-w-[var(--anchor-width)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
              "origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input
                className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder={searchPlaceholder}
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-auto p-1">
              <Combobox.Empty className="px-2 py-3 text-center text-xs text-muted-foreground">
                无匹配项
              </Combobox.Empty>
              <Combobox.List>
                {(item: SearchableSelectItem) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none",
                      "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                      "data-selected:font-medium",
                    )}
                  >
                    <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                      <CheckIcon className="size-3.5" />
                    </Combobox.ItemIndicator>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
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

/** @deprecated 使用 SearchableSelect */
export const SearchableSelectFiltered = SearchableSelect;
