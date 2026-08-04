"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

function domainFromHomepage(homepage?: string | null): string | null {
  if (!homepage) return null;
  try {
    return new URL(homepage).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function resolveDomain(opts: {
  brandId?: string | null;
  homepage?: string | null;
  mcpUrl?: string | null;
}): string | null {
  const fromHome = domainFromHomepage(opts.homepage);
  if (fromHome) return fromHome;
  if (opts.mcpUrl) {
    try {
      const host = new URL(opts.mcpUrl).hostname.replace(/^www\./, "");
      if (host && !host.startsWith("zakura")) return host;
    } catch {
      /* ignore */
    }
  }
  const id = (opts.brandId ?? "").trim();
  if (id.includes(".")) {
    try {
      return new URL(id.includes("://") ? id : `https://${id}`).hostname.replace(/^www\./, "");
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function brandIconUrl(domain: string, size = 128): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

export type BrandIconProps = {
  brandId?: string | null;
  name?: string | null;
  /** 字母回退时的背景色 */
  accent?: string | null;
  homepage?: string | null;
  mcpUrl?: string | null;
  /** 直接指定图标 URL（优先） */
  iconUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const SIZE = {
  sm: "size-8 text-[10px]",
  md: "size-10 text-sm",
  lg: "size-12 text-base",
} as const;

/** 品牌图标：优先官方 favicon，失败回退到字母块 */
export function BrandIcon({
  brandId,
  name,
  accent,
  homepage,
  mcpUrl,
  iconUrl,
  size = "md",
  className,
}: BrandIconProps) {
  const domain = resolveDomain({ brandId, homepage, mcpUrl });
  const src = iconUrl || (domain ? brandIconUrl(domain) : null);
  const [failed, setFailed] = useState(false);
  const letter = (name || brandId || "?").trim().slice(0, 2).toUpperCase() || "?";

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg font-semibold text-white",
          SIZE[size],
          className,
        )}
        style={{ background: accent || "#334155" }}
        aria-hidden
      >
        {letter}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-background",
        SIZE[size],
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="size-[65%] object-contain"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
