"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const routeParams = useParams<{ provider: string }>();
  const provider = routeParams.provider;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    const errDesc = params.get("error_description");

    void (async () => {
      if (!provider || err || !code || !state) {
        setError(errDesc || err || (!provider ? "缺少 OAuth 提供商" : "缺少授权码"));
        return;
      }
      try {
        const res = await api<{
          session: string;
          next?: string;
          tenant?: { onboardingCompleted?: boolean };
        }>(`/api/auth/oauth/${encodeURIComponent(provider)}/callback`, {
          method: "POST",
          json: { code, state },
        });
        setSession(res.session);
        const next =
          res.next ??
          (res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents");
        router.replace(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, provider, router]);

  if (!error) {
    // 成功路径：静默加载，浏览器进度条已足够反馈
    return <PageLoading />;
  }

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="w-full max-w-xs space-y-5 animate-in-page text-center">
        <div className="flex items-center justify-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-destructive/30 text-destructive">
            <X className="size-4" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/login" />}>
          返回登录
        </Button>
      </div>
    </div>
  );
}

export default function OauthLoginCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CallbackInner />
    </Suspense>
  );
}
