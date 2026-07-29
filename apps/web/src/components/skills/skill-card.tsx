"use client";

import { CheckCircle2, Download, Package, Sparkles, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SKILL_STORE_LABEL, formatCount, type SkillSearchItem } from "@/lib/skills";

const STORE_BADGE: Record<string, "default" | "secondary" | "outline"> = {
  builtin: "default",
  "skills-sh": "secondary",
  github: "outline",
};

export function SkillCard({
  item,
  onPreview,
  onInstall,
  busy,
  className,
}: {
  item: SkillSearchItem;
  onPreview: () => void;
  onInstall: () => void;
  busy?: boolean;
  className?: string;
}) {
  const installs = formatCount(item.installs);
  const stars = formatCount(item.stars);

  return (
    <div
      className={cn(
        "group/skill relative flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70",
            item.store === "builtin" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {item.store === "builtin" ? (
            <Sparkles className="size-4" />
          ) : (
            <Package className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onPreview}
              className="truncate text-left text-sm font-medium hover:underline"
              title={item.name}
            >
              {item.name}
            </button>
            {item.installed ? (
              <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label="已安装" />
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground" title={item.source}>
            {item.source}
          </p>
        </div>
      </div>

      <p className="line-clamp-3 min-h-[3rem] text-xs leading-5 text-muted-foreground">
        {item.description || "暂无描述，点开可预览 SKILL.md 全文"}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={STORE_BADGE[item.store] ?? "outline"} className="text-[10px]">
          {SKILL_STORE_LABEL[item.store] ?? item.store}
        </Badge>
        {installs ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Download className="size-3" />
            {installs}
          </span>
        ) : null}
        {stars ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Star className="size-3" />
            {stars}
          </span>
        ) : null}
      </div>

      <div className="mt-auto flex gap-1.5 pt-1">
        <Button size="sm" variant="outline" className="flex-1" onClick={onPreview}>
          预览
        </Button>
        <Button size="sm" className="flex-1" disabled={busy} onClick={onInstall}>
          {item.installed ? "重新安装" : "安装"}
        </Button>
      </div>
    </div>
  );
}

export function SkillCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted/70" />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-muted/70" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-muted/70" />
      </div>
      <div className="h-8 w-full animate-pulse rounded-md bg-muted/60" />
    </div>
  );
}
