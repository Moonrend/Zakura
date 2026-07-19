import { cn } from "@/lib/utils";

/** Dashboard 内容区统一宽度；勿在页面再套一层 max-w / mx-auto */
export function PageShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("page-shell", className)}>{children}</div>
  );
}

/** 设置页顶栏：标题 + 右侧操作，无说明文案 */
export function SettingsHeader({
  title,
  actions,
  className,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      <h1 className="font-heading text-lg font-semibold tracking-tight">{title}</h1>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

/** 单层设置区块，避免卡片套卡片 */
export function SettingsSection({
  title,
  children,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "space-y-3 rounded-xl border border-border/80 bg-card p-4 shadow-[var(--shadow-soft)] transition-[border-color,box-shadow] duration-200 ease-out-soft",
        className,
      )}
    >
      {title ? (
        <div className="text-sm font-medium tracking-tight">{title}</div>
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
