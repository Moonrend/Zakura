"use client";

import { ExternalLink, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type McpServerCardData = {
  id: string;
  title: string;
  /** 副标题 / 包名 / URL */
  subtitle?: string;
  description?: string;
  version?: string;
  badges?: Array<{ label: string; variant?: "default" | "secondary" | "outline" }>;
  stars?: number;
  repositoryUrl?: string;
  installed?: boolean;
};

type McpServerCardProps = {
  server: McpServerCardData;
  onInstall?: () => void;
  installLabel?: string;
  className?: string;
  /** 安装中禁用 */
  busy?: boolean;
};

/** 商店 / 引导共用的 MCP 服务器卡片 */
export function McpServerCard({
  server,
  onInstall,
  installLabel = "安装",
  className,
  busy,
}: McpServerCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{server.title}</div>
          {server.subtitle ? (
            <code className="block truncate text-[10px] text-muted-foreground">
              {server.subtitle}
            </code>
          ) : null}
        </div>
        {server.version ? <Badge variant="outline">{server.version}</Badge> : null}
      </div>

      <p className="line-clamp-3 flex-1 text-xs text-muted-foreground">
        {server.description || "无描述"}
      </p>

      {(server.badges?.length || server.stars != null) && (
        <div className="flex flex-wrap items-center gap-1">
          {server.badges?.map((b) => (
            <Badge
              key={b.label}
              variant={b.variant ?? "secondary"}
              className="text-[10px]"
            >
              {b.label}
            </Badge>
          ))}
          {server.stars != null ? (
            <Badge variant="secondary" className="gap-0.5 text-[10px]">
              <Star className="size-3" />
              {server.stars.toLocaleString()}
            </Badge>
          ) : null}
        </div>
      )}

      <div className="flex gap-1.5 pt-1">
        {onInstall ? (
          <Button
            size="sm"
            disabled={busy || server.installed}
            onClick={onInstall}
          >
            {server.installed ? "已安装" : installLabel}
          </Button>
        ) : null}
        {server.repositoryUrl ? (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={
              <a href={server.repositoryUrl} target="_blank" rel="noreferrer" />
            }
          >
            仓库
            <ExternalLink className="size-3 opacity-50" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
