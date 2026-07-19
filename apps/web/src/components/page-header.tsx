import { cn } from "@/lib/utils";

/** @deprecated 优先使用 SettingsHeader；保留兼容旧页 */
export function PageHeader({
  title,
  description: _description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  void _description;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
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
