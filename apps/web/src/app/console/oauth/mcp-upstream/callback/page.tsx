"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { MCP_OAUTH_MESSAGE, broadcastMcpOauthResult } from "@/lib/mcp-oauth";
import { Button } from "@/components/ui/button";

function CallbackInner() {
  const params = useSearchParams();
  const ok = params.get("ok");
  const error = params.get("error");
  const instanceId = params.get("instanceId");
  const [msg, setMsg] = useState("处理中…");
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [fromPopup, setFromPopup] = useState(false);

  useEffect(() => {
    const hasOpener = typeof window !== "undefined" && !!window.opener;
    setFromPopup(hasOpener);

    void (async () => {
      if (ok === "1") {
        // 弹窗常无 zakura_session（跨源 / 分区存储）；令牌已在服务端 callback 写入。
        // 健康检查由 opener（install-flow）带 session 调用 verify，此处不再请求以免 Unauthorized。
        setMsg("上游 OAuth 授权成功，令牌已写入实例配置。");
        setStatus("ok");
        broadcastMcpOauthResult({
          type: MCP_OAUTH_MESSAGE,
          ok: true,
          instanceId: instanceId ?? undefined,
        });
        setFromPopup(true);
        return;
      }
      if (error) {
        setMsg(`授权失败：${error}`);
        setStatus("error");
        broadcastMcpOauthResult({
          type: MCP_OAUTH_MESSAGE,
          ok: false,
          error,
          instanceId: instanceId ?? undefined,
        });
        setFromPopup(true);
        return;
      }
      setMsg("未收到有效回调参数。");
      setStatus("error");
    })();
  }, [ok, error, instanceId]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <div
        className={`flex size-12 items-center justify-center rounded-full border ${
          status === "ok"
            ? "border-foreground bg-foreground text-background"
            : status === "error"
              ? "border-destructive text-destructive"
              : "border-border text-muted-foreground"
        }`}
      >
        {status === "loading" ? (
          <Loader2 className="size-5 animate-spin" />
        ) : status === "ok" ? (
          <Check className="size-5" />
        ) : (
          <X className="size-5" />
        )}
      </div>
      <h1 className="font-heading text-lg font-semibold">上游 MCP OAuth</h1>
      <p className="text-sm text-muted-foreground">{msg}</p>
      {fromPopup && status !== "loading" ? (
        <p className="text-xs text-muted-foreground">
          可关闭此标签页，返回引导页继续。
        </p>
      ) : null}
      <div className="flex gap-2">
        {fromPopup ? (
          <Button
            variant="outline"
            onClick={() => {
              window.close();
            }}
          >
            关闭标签页
          </Button>
        ) : null}
        <Button
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
          返回 MCP 管理
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/dashboard/mcp/store" />}
        >
          商店
        </Button>
      </div>
    </div>
  );
}

export default function McpUpstreamOauthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-sm text-muted-foreground">…</div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
