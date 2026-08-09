"use client";

import { Pencil, Trash2, Waypoints } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CloudAgentQueuedMessage } from "@/lib/cloud-agent";

function previewText(item: CloudAgentQueuedMessage): string {
  const text = item.content.trim();
  if (text) return text;
  return item.attachments?.length
    ? item.attachments.map((a) => a.name).join("、")
    : "空消息";
}

/**
 * 输入框上方的排队消息（服务端权威队列）。
 * 行内只读预览；「编辑」召回主输入框；「立即发送」只打断并用这一条开新回合。
 */
export function MessageQueue({
  items,
  onEdit,
  onRemove,
  onInterrupt,
  className,
}: {
  items: CloudAgentQueuedMessage[];
  onEdit: (messageId: string) => void;
  onRemove: (messageId: string) => void;
  onInterrupt: (messageId: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-col items-end gap-1.5 px-1 pb-2", className)}>
      {items.map((item, index) => (
        <div
          key={item.messageId}
          className={cn(
            "flex max-w-[min(100%,28rem)] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-2.5",
            item.interrupt && "border-ring/40",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
            {previewText(item)}
          </span>
          {item.attachments && item.attachments.length > 0 ? (
            <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
              {item.attachments.length}
            </Badge>
          ) : null}
          <div className="flex shrink-0 items-center">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`编辑排队消息 ${index + 1}`}
              className="text-muted-foreground"
              onClick={() => onEdit(item.messageId)}
            >
              <Pencil />
            </Button>
            {!item.interrupt ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="立即发送此条"
                className="text-muted-foreground"
                onClick={() => onInterrupt(item.messageId)}
              >
                <Waypoints />
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="移除"
              className="text-muted-foreground"
              onClick={() => onRemove(item.messageId)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
