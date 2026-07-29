"use client";

import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 列表页统一的搜索框：左侧放大镜、右侧一键清空、Esc 清空。
 * 搭配 `useFuzzySearch` 使用，模糊匹配而不是严格子串。
 */
export function SearchField({
  value,
  onValueChange,
  placeholder = "搜索…",
  className,
  autoFocus,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onValueChange("");
          }
        }}
        className={cn(
          "h-9 w-full rounded-lg border border-input bg-transparent pr-8 pl-8 text-sm outline-none",
          "transition-[border-color,box-shadow] duration-200 ease-fluid",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => onValueChange("")}
          className="animate-pop absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** 搜索无结果时的占位 */
export function NoSearchResult({ query }: { query: string }) {
  return (
    <div className="animate-rise rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
      没有匹配「{query}」的结果
    </div>
  );
}
