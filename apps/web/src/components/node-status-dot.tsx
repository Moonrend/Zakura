import { cn } from "@/lib/utils";

/** 节点在线状态的 1.5 号实心点：在线绿、维护黄、其余灰。 */
export function NodeStatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        status === "online" ? "bg-success" : status === "draining" ? "bg-warning" : "bg-muted-foreground/40",
        className,
      )}
    />
  );
}
