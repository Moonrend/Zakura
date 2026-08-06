"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import type { WebSource } from "@/lib/tool-result";

/**
 * 站点图标：直接取站点自己的 /favicon.ico，失败降级为首字母色块。
 * 不走第三方图标服务，避免把用户浏览过的域名泄露给第四方，也不受墙影响。
 */
export function Favicon({
  domain,
  className,
}: {
  domain: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = domain.replace(/^[^a-z0-9]+/i, "").charAt(0).toUpperCase() || "?";

  if (failed || !domain) {
    return (
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground",
          className,
        )}
        aria-hidden
      >
        {letter}
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={`https://${domain}/favicon.ico`}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn("rounded-full bg-muted object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

/** 叠放的站点图标，用在未展开的工具行上：一眼看出「查了哪几家」 */
export function FaviconStack({
  sources,
  max = 4,
  className,
}: {
  sources: WebSource[];
  max?: number;
  className?: string;
}) {
  if (sources.length === 0) return null;
  const seen = new Set<string>();
  const unique = sources.filter((s) => {
    if (seen.has(s.domain)) return false;
    seen.add(s.domain);
    return true;
  });
  const shown = unique.slice(0, max);
  const rest = unique.length - shown.length;

  return (
    <span className={cn("flex shrink-0 items-center", className)}>
      {shown.map((s, i) => (
        <Favicon
          key={s.domain}
          domain={s.domain}
          className={cn(
            "size-4 shrink-0 ring-2 ring-background transition-transform duration-200 ease-fluid",
            i > 0 && "-ml-1.5",
          )}
        />
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      )}
    </span>
  );
}

/**
 * 单条来源 chip：图标 + 标题，整体一颗药丸。
 * 比卡片省一大截纵向空间，十来条来源也能一屏看完；完整标题与链接放 title。
 */
export function WebSourceChip({
  source,
  index = 0,
  className,
}: {
  source: WebSource;
  index?: number;
  className?: string;
}) {
  const label = source.title && source.title !== source.domain ? source.title : source.domain;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={`${source.title || source.domain}\n${source.url}`}
      style={{ animationDelay: `${Math.min(index, 9) * 26}ms` }}
      className={cn(
        "animate-rise inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border/60 bg-background py-[3px] pr-2.5 pl-[3px] text-[11.5px] text-muted-foreground",
        "transition-[background-color,border-color,color] duration-150 ease-out-soft",
        "hover:border-border hover:bg-muted/60 hover:text-foreground",
        className,
      )}
    >
      <Favicon domain={source.domain} className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

/** 来源 chip 列表：换行铺开，顺序错峰进场 */
export function WebSourceChips({
  sources,
  className,
}: {
  sources: WebSource[];
  className?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {sources.map((s, i) => (
        <WebSourceChip key={`${s.url}-${i}`} source={s} index={i} />
      ))}
    </div>
  );
}
