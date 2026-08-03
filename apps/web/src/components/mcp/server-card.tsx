"use client";

import { ExternalLink, Loader2, Star } from "lucide-react";
import { BrandIcon } from "@/components/brand-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";
import type { McpInstallPhase } from "@/components/mcp/install-flow";

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
  /** 品牌图标：slug / curated id */
  brandId?: string;
  homepage?: string;
  mcpUrl?: string;
  accent?: string;
  /** 仅当为真实 URL 时传入 */
  iconUrl?: string;
};

type McpServerCardProps = {
  server: McpServerCardData;
  onInstall?: () => void;
  installLabel?: string;
  className?: string;
  /** 安装中禁用按钮 */
  busy?: boolean;
  /** 卡片内安装进度（顶栏无限滚动 + 毛玻璃遮罩） */
  installPhase?: McpInstallPhase;
  installMessage?: string;
};

function isInstallingPhase(phase?: McpInstallPhase) {
  return (
    phase === "creating" ||
    phase === "awaiting_oauth" ||
    phase === "verifying"
  );
}

/** 商店 / 引导共用的 MCP 服务器卡片 */
export function McpServerCard({
  server,
  onInstall,
  installLabel = "安装",
  className,
  busy,
  installPhase = "idle",
  installMessage,
}: McpServerCardProps) {
  const installing = isInstallingPhase(installPhase);
  const showProgress =
    installing || installPhase === "done" || installPhase === "error";

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-4",
        className,
      )}
    >
      {showProgress ? (
        <div className="absolute inset-x-0 top-0 z-30">
          <ProgressLinear
            flush
            indeterminate={installing}
            value={
              installPhase === "done"
                ? 100
                : installPhase === "error"
                  ? 100
                  : null
            }
            barClassName={cn(
              installPhase === "error" && "bg-destructive",
              installPhase === "done" && "bg-foreground",
            )}
          />
        </div>
      ) : null}

      {installing ? (
        <div
          className={cn(
            "absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-[inherit] bg-card/90",
          )}
        >
          <Loader2 className="size-5 animate-spin text-foreground" />
          <p className="px-3 text-center text-xs font-medium">
            {installMessage ||
              (installPhase === "awaiting_oauth"
                ? "等待授权…"
                : installPhase === "verifying"
                  ? "正在校验…"
                  : "正在安装并启动…")}
          </p>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <BrandIcon
            brandId={server.brandId ?? server.id}
            name={server.title}
            accent={server.accent}
            homepage={server.homepage}
            mcpUrl={server.mcpUrl ?? server.subtitle}
            iconUrl={server.iconUrl}
            size="sm"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{server.title}</div>
            {server.subtitle ? (
              <code className="block truncate text-[10px] text-muted-foreground">
                {server.subtitle}
              </code>
            ) : null}
          </div>
        </div>
        {server.version ? <Badge variant="outline">{server.version}</Badge> : null}
      </div>

      <p className="line-clamp-1 flex-1 text-xs text-muted-foreground">
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
            disabled={busy || installing || server.installed}
            onClick={onInstall}
          >
            {server.installed
              ? "已安装"
              : installing
                ? "安装中…"
                : installLabel}
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
