"use client";

import { Check, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SaveStatus } from "@/hooks/use-auto-save";

/** Dashboard 内容区统一宽度；勿在页面再套一层 max-w / mx-auto */
export function PageShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("page-shell", className)}>{children}</div>;
}

/**
 * 页面顶栏：标题 + 右侧操作。
 *
 * 标题用 text-xl/2xl 而不是原来的 text-lg。原先几乎所有字号都挤在 14–18px 之间，
 * h1 只比正文大一点点、小标签又只小一点点，层级全靠灰度区分 —— 结果每块内容都在
 * 同一个音量上喊，页面显得又吵又不稳。跟正文拉开一档真实的字号差，
 * 眼睛才能一眼找到「这一页是关于什么的」。
 */
export function SettingsHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-3 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

/** 自动保存状态指示 */
export function SettingsSaveIndicator({
  status,
  error,
  className,
}: {
  status: SaveStatus;
  error?: string | null;
  className?: string;
}) {
  if (status === "idle") {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        自动保存
      </span>
    );
  }
  if (status === "dirty") {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        未保存…
      </span>
    );
  }
  if (status === "saving") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="size-3 animate-spin" />
        保存中
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs text-muted-foreground",
          className,
        )}
      >
        <Check className="size-3 text-success" />
        已保存
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-[14rem] items-center gap-1 text-xs text-destructive",
        className,
      )}
      title={error ?? undefined}
    >
      <AlertCircle className="size-3 shrink-0" />
      <span className="truncate">{error || "保存失败"}</span>
    </span>
  );
}

/** 单层设置区块，避免卡片套卡片 */
export function SettingsSection({
  id,
  title,
  description,
  children,
  className,
  action,
}: {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-20 space-y-3 rounded-lg border border-border bg-card p-4 transition-[border-color,background-color,box-shadow] duration-150 ease-out-soft",
        className,
      )}
    >
      {title || description || action ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            {title ? (
              <div className="text-sm font-medium">{title}</div>
            ) : null}
            {description ? (
              <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 一行设置：左侧标签，右侧控件 */
export function SettingsField({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-1",
        className,
      )}
    >
      <div className="min-w-0 text-sm">{label}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * 设置行：标题 + 可选说明 + 右侧控件。
 * 简单开关类设置的统一形态，便于分类扩展。
 */
export function SettingsRow({
  label,
  description,
  children,
  className,
  htmlFor,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <label
          htmlFor={htmlFor}
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          {label}
        </label>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center pt-0.5">{children}</div>
    </div>
  );
}

/** 设置分类侧栏导航（可扩展） */
export function SettingsCategoryNav({
  items,
  activeId,
  onSelect,
  className,
}: {
  items: Array<{ id: string; label: string; description?: string }>;
  activeId?: string;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  return (
    <nav
      className={cn(
        "scrollbar-subtle scrollbar-x-compact scrollbar-edge-pad -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0",
        className,
      )}
      aria-label="设置分类"
    >
      {items.map((item) => {
        const active = activeId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onSelect?.(item.id);
              const el = document.getElementById(`settings-${item.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={cn(
              "shrink-0 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            <div>{item.label}</div>
            {item.description ? (
              <div className="mt-0.5 hidden text-[11px] font-normal opacity-80 md:block">
                {item.description}
              </div>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

/** 表格操作列：右对齐图标按钮组 */
export function TableActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-end gap-0.5", className)}>
      {children}
    </div>
  );
}
