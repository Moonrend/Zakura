"use client";

import { useEffect, useRef, useState } from "react";
import {
  type StoreInstallPreview,
  type StoreServerLike,
  type UnifiedMcpConfig,
} from "@/lib/mcp-config";
import {
  McpInstallFlow,
  type McpInstallPhase,
} from "@/components/mcp/install-flow";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageLoading } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";

export type InstallResult = {
  instanceId: string;
  slug: string;
  authRequired?: boolean;
};

type McpInstallDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已解析的统一配置；加载中可为 null */
  config: UnifiedMcpConfig | null;
  /** 商店多方案时展示选择器 */
  previewOptions?: StoreInstallPreview[];
  storeServer?: StoreServerLike | null;
  onSelectPreview?: (option: StoreInstallPreview) => void;
  loading?: boolean;
  /** dialogWasOpen：完成时弹窗是否仍打开；关闭则不应跳转 */
  onComplete?: (result: InstallResult, meta: { dialogWasOpen: boolean }) => void;
  onPhaseChange?: (phase: McpInstallPhase) => void;
  title?: string;
  description?: string;
};

function isBusyPhase(phase: McpInstallPhase) {
  return (
    phase === "creating" ||
    phase === "awaiting_oauth" ||
    phase === "verifying"
  );
}

/**
 * 统一安装对话框。
 * 安装进行中即使关闭弹窗也会保活 Flow（卡片继续显示进度）；
 * 仅当完成时弹窗仍打开才建议跳转详情页。
 */
export function McpInstallDialog({
  open,
  onOpenChange,
  config,
  previewOptions = [],
  storeServer,
  onSelectPreview,
  loading,
  onComplete,
  onPhaseChange,
  title,
  description,
}: McpInstallDialogProps) {
  const [phase, setPhase] = useState<McpInstallPhase>("idle");
  const openRef = useRef(open);
  openRef.current = open;

  const selectedId = config?.storeMeta
    ? `${config.storeMeta.prefer}:${config.storeMeta.packageIndex ?? ""}:${config.storeMeta.remoteUrl ?? ""}`
    : config?.id;

  // 切换 MCP / 方案时重置阶段
  useEffect(() => {
    setPhase("idle");
  }, [selectedId]);

  const busy = isBusyPhase(phase);
  // 安装中 / 出错待重试：保持 Dialog 树挂载，避免关闭后中断请求或丢失错误态
  const dialogMounted = open || busy || phase === "error";
  const showChrome = open;

  const headerTitle = title ?? (config ? `安装 ${config.name}` : "安装 MCP");
  const headerDesc = description?.trim() || null;

  const firstStdioId = previewOptions.find((o) => o.prefer === "stdio")?.id;

  function handleOpenChange(next: boolean) {
    if (!next && busy) {
      // 用户关闭：隐藏 UI，但保持挂载继续安装
      onOpenChange(false);
      return;
    }
    if (!next && phase === "error") {
      setPhase("idle");
      onPhaseChange?.("idle");
    }
    onOpenChange(next);
  }

  function handlePhaseChange(next: McpInstallPhase) {
    setPhase(next);
    onPhaseChange?.(next);
    // 安装开始：收起弹窗，进度改由卡片顶栏；授权 / 出错时再打开弹窗
    if (next === "creating") {
      onOpenChange(false);
    } else if (next === "awaiting_oauth" || next === "error") {
      onOpenChange(true);
    }
  }

  return (
    <Dialog open={dialogMounted} onOpenChange={handleOpenChange}>
      <DialogContent
        showOverlay={showChrome}
        className={cn(
          "max-w-lg shadow-lg",
          !showChrome &&
            "pointer-events-none fixed left-[-9999px] top-0 opacity-0",
        )}
        // 隐藏态不显示关闭按钮，避免误触
        showCloseButton={showChrome}
      >
        {showChrome ? (
          <DialogHeader>
            <DialogTitle>{headerTitle}</DialogTitle>
            {headerDesc ? (
              <DialogDescription>{headerDesc}</DialogDescription>
            ) : null}
          </DialogHeader>
        ) : null}

        {loading || !config ? (
          showChrome ? (
            <PageLoading />
          ) : null
        ) : (
          <div className={cn("space-y-4", !showChrome && "sr-only")}>
            {showChrome &&
            previewOptions.length > 1 &&
            storeServer &&
            onSelectPreview &&
            (phase === "idle" || phase === "error") ? (
              <div className="space-y-1.5">
                <Label>安装方案</Label>
                <div className="space-y-1.5">
                  {previewOptions.map((opt) => {
                    const active =
                      config.storeMeta?.prefer === opt.prefer &&
                      (opt.prefer === "http"
                        ? config.storeMeta.remoteUrl === opt.remoteUrl
                        : config.storeMeta.packageIndex === opt.packageIndex);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => onSelectPreview(opt)}
                        className={cn(
                          "w-full rounded-lg px-3 py-2 text-left ring-1 transition-colors",
                          active
                            ? "bg-muted ring-foreground/25"
                            : "bg-card ring-foreground/10 hover:bg-muted/50",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px]">
                            {opt.label}
                          </Badge>
                          {opt.kind === "stdio-oci" ? (
                            <span className="text-[10px] text-muted-foreground">
                              Docker 运行
                            </span>
                          ) : null}
                          {opt.id === firstStdioId ? (
                            <Badge variant="outline" className="text-[10px]">
                              推荐
                            </Badge>
                          ) : null}
                        </div>
                        <code className="mt-1 block break-all text-[11px] text-foreground">
                          {opt.summary}
                        </code>
                        {opt.detail ? (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {opt.detail}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <McpInstallFlow
              key={selectedId ?? config.id}
              config={config}
              hideProgress
              onPhaseChange={handlePhaseChange}
              onComplete={(result) => {
                const dialogWasOpen = openRef.current;
                setPhase("done");
                onPhaseChange?.("done");
                onComplete?.(result, { dialogWasOpen });
                if (dialogWasOpen) onOpenChange(false);
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
