import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  iconClassName,
  showName = true,
}: {
  className?: string;
  iconClassName?: string;
  showName?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <img
        src="/icons/icon-192.png"
        alt=""
        aria-hidden="true"
        className={cn("size-7 shrink-0 rounded-[20%]", iconClassName)}
      />
      {showName ? (
        <span className="truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          Zakura
        </span>
      ) : null}
    </div>
  );
}
