"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, X } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { Button } from "@/components/ui/button";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [msg, setMsg] = useState("正在完成 ZeroCat 登录…");

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    void (async () => {
      if (error) {
        setStatus("error");
        setMsg(errorDescription || error || "授权被拒绝");
        return;
      }
      if (!code || !state) {
        setStatus("error");
        setMsg("缺少授权码或 state");
        return;
      }
      try {
        const res = await api<{
          session: string;
          next?: string;
          tenant?: { onboardingCompleted?: boolean };
        }>("/api/auth/oauth/zerocat/callback", {
          method: "POST",
          json: { code, state },
        });
        setSession(res.session);
        setStatus("ok");
        setMsg("登录成功，正在跳转…");
        toast.success("ZeroCat 登录成功");
        const next =
          res.next ??
          (res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents");
        router.replace(next);
      } catch (err) {
        setStatus("error");
        setMsg(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [params, router]);

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
      <p className="text-sm text-muted-foreground">{msg}</p>
      {status === "error" ? (
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          返回登录
        </Button>
      ) : null}
    </div>
  );
}

/** SaaS ZeroCat OAuth callback — listed in strip-manifest. */
export default function ZerocatOauthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground">
          加载中…
        </div>
      }
    >
      <CallbackInner />
    </Suspense>
  );
}
