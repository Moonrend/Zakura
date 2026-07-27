"use client";

import { useState } from "react";
import {
  BookMarked,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  Library,
  Search,
  ScrollText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  CloudAgentContextSourceItem,
  CloudAgentContextSourceKind,
} from "@/lib/cloud-agent";

const KIND_META: Record<
  CloudAgentContextSourceKind,
  { label: string; icon: typeof Library }
> = {
  memory: { label: "记忆", icon: BookMarked },
  file: { label: "文件", icon: FileText },
  search: { label: "搜索", icon: Search },
  web: { label: "网页", icon: Globe },
  summary: { label: "摘要", icon: ScrollText },
  other: { label: "其他", icon: Library },
};

function SourceActions({
  item,
  onOpenFile,
}: {
  item: CloudAgentContextSourceItem;
  onOpenFile?: (path: string) => void;
}) {
  if (!item.path && !item.url) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.path && onOpenFile ? (
        <Button size="xs" variant="outline" onClick={() => onOpenFile(item.path!)}>
          <FolderOpen data-icon="inline-start" />
          打开文件
        </Button>
      ) : null}
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ size: "xs", variant: "outline" }))}
        >
          <ExternalLink data-icon="inline-start" />
          打开链接
        </a>
      ) : null}
    </div>
  );
}

function SourceItem({
  item,
  onOpenFile,
}: {
  item: CloudAgentContextSourceItem;
  onOpenFile?: (path: string) => void;
}) {
  const meta = KIND_META[item.kind] ?? KIND_META.other;
  const Icon = meta.icon;
  const hasBody = Boolean(item.content?.trim());
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border/60 bg-muted/15">
        <CollapsibleTrigger
          disabled={!hasBody}
          className={cn(
            "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
            hasBody && "hover:bg-muted/40",
            !hasBody && "cursor-default",
          )}
        >
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-normal">
                {meta.label}
              </Badge>
              {item.layer ? (
                <Badge variant="outline" className="font-normal">
                  {item.layer}
                </Badge>
              ) : null}
            </span>
            <span className="block truncate text-sm text-foreground">{item.title}</span>
            {item.path ? (
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {item.path}
              </span>
            ) : null}
            {item.url && !item.path ? (
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {item.url}
              </span>
            ) : null}
          </span>
          {hasBody ? (
            <ChevronDown
              className={cn(
                "mt-1 size-4 shrink-0 text-muted-foreground/60 transition-transform",
                open && "rotate-180",
              )}
            />
          ) : null}
        </CollapsibleTrigger>

        {hasBody ? (
          <CollapsibleContent>
            <Separator />
            <div className="space-y-2.5 px-3 py-2.5">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
                {item.content}
              </pre>
              <SourceActions item={item} onOpenFile={onOpenFile} />
            </div>
          </CollapsibleContent>
        ) : (
          (item.path || item.url) && (
            <>
              <Separator />
              <div className="px-3 py-2">
                <SourceActions item={item} onOpenFile={onOpenFile} />
              </div>
            </>
          )
        )}
      </div>
    </Collapsible>
  );
}

/** 「来源」触发按钮：放入回答下方工具栏 */
export function AnswerSourcesTrigger({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-muted-foreground"
            aria-label={`来源 ${count}`}
            onClick={onClick}
          />
        }
      >
        <Library className="size-3.5" />
        <span>来源</span>
        <span className="tabular-nums text-muted-foreground/70">{count}</span>
      </TooltipTrigger>
      <TooltipContent>查看来源</TooltipContent>
    </Tooltip>
  );
}

/** 来源侧栏：列出系统注入与工具检索到的材料 */
export function AnswerSourcesSheet({
  open,
  onOpenChange,
  items,
  onOpenFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CloudAgentContextSourceItem[];
  onOpenFile?: (path: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/60">
          <SheetTitle>来源</SheetTitle>
          <SheetDescription>
            本轮回答参考的记忆、搜索结果与相关文件等
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 py-2 text-xs text-muted-foreground">共 {items.length} 条</div>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          <div className="flex flex-col gap-2">
            {items.map((item, i) => (
              <SourceItem
                key={
                  item.id ?? item.path ?? item.url ?? `${item.kind}-${item.title}-${i}`
                }
                item={item}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
