"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { MCP_OAUTH_MESSAGE, broadcastMcpOauthResult } from "@/lib/mcp-oauth";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

function CallbackInner() {
  const params = useSearchParams();
  const ok = params.get("ok");
  const error = params.get("error");
  const instanceId = params.get("instanceId");
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [fromPopup, setFromPopup] = useState(false);

  useEffect(() => {
    const hasOpener = typeof window !== "undefined" && !!window.opener;
    setFromPopup(hasOpener);

    if (ok === "1") {
      setStatus("ok");
      broadcastMcpOauthResult({
        type: MCP_OAUTH_MESSAGE,
        ok: true,
        instanceId: instanceId ?? undefined,
      });
      // 弹窗场景：授权成功后自动关闭
      if (hasOpener) {
        setTimeout(() => window.close(), 800);
      }
      return;
    }

    setStatus("error");
    broadcastMcpOauthResult({
      type: MCP_OAUTH_MESSAGE,
      ok: false,
      error: error ?? "unknown",
      instanceId: instanceId ?? undefined,
    });
  }, [ok, error, instanceId]);

  if (status === "loading") {
    return <PageLoading />;
  }

  if (status === "ok") {
    return (
      <div className="grid min-h-svh place-items-center p-6">
        <div className="w-full max-w-xs space-y-4 animate-in-page text-center">
          <p className="text-sm text-muted-foreground">
            {fromPopup ? "授权成功，正在关闭…" : "授权成功"}
          </p>
          {!fromPopup ? (
            <Button
              size="sm"
              nativeButton={false}
              render={
                <Link
                  href={
                    instanceId
                      ? `/dashboard/mcp/${encodeURIComponent(instanceId)}`
                      : "/dashboard/mcp"
                  }
                />
              }
            >
              继续
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="w-full max-w-xs space-y-5 animate-in-page text-center">
        <div className="flex items-center justify-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-destructive/30 text-destructive">
            <X className="size-4" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{error ?? "授权失败"}</p>
        <div className="flex justify-center gap-2">
          {fromPopup ? (
            <Button variant="outline" size="sm" onClick={() => window.close()}>
              关闭
            </Button>
          ) : null}
          <Button
            size="sm"
            nativeButton={false}
            render={
              <Link
                href={
                  instanceId
                    ? `/dashboard/mcp/${encodeURIComponent(instanceId)}`
                    : "/dashboard/mcp"
                }
              />
            }
          >
            返回
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function McpUpstreamOauthCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CallbackInner />
    </Suspense>
  );
}
