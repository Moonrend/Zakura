"use client";

import { BadgeCheck, Check, Download, GitFork, HardDrive, Package, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageLoading } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";
import { formatCount, type SkillSearchItem, type SkillStoreId } from "@/lib/skills";

const STORE_ICON: Record<SkillStoreId, typeof Package> = {
  builtin: Package,
  curated: BadgeCheck,
  "skills-sh": Package,
  github: GitFork,
};

export function SkillCard({
  item,
  onOpen,
  className,
}: {
  item: SkillSearchItem;
  onOpen: () => void;
  className?: string;
}) {
  const installs = formatCount(item.installs);
  const stars = formatCount(item.stars);
  const Icon = STORE_ICON[item.store] ?? Package;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3.5 text-left surface-interactive hover:border-foreground/15 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:p-4",
        className,
      )}
    >
      <div className="flex w-full items-start gap-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className="truncate text-sm font-medium group-hover:underline"
              title={item.name}
            >
              {item.name}
            </span>
            {item.installed ? (
              <Badge
                variant="secondary"
                className="shrink-0 gap-0.5 px-1 text-[10px] text-success"
              >
                <Check className="size-2.5" />
                已装
              </Badge>
            ) : null}
          </span>
          <span
            className="block truncate font-mono text-[11px] text-muted-foreground"
            title={item.source}
          >
            {item.source}
          </span>
        </span>
      </div>

      {item.description ? (
        <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground sm:line-clamp-3 sm:min-h-12 sm:leading-5">
          {item.description}
        </p>
      ) : null}

      <div className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
        {installs ? (
          <span className="inline-flex items-center gap-1">
            <Download className="size-3" />
            {installs}
          </span>
        ) : null}
        {stars ? (
          <span className="inline-flex items-center gap-1">
            <Star className="size-3" />
            {stars}
          </span>
        ) : null}
        {item.cached ? (
          <span className="inline-flex items-center gap-1">
            <HardDrive className="size-3" />
            缓存
          </span>
        ) : null}
        <span className="ml-auto text-foreground/70 group-hover:text-foreground">
          {item.installed ? "重装 →" : "安装 →"}
        </span>
      </div>
    </button>
  );
}

export function SkillCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5 sm:p-4">
      <PageLoading />
    </div>
  );
}
