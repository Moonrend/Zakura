"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, setSession } from "@/lib/api";
import { AuthScreen } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    void (async () => {
      if (!code || !state) {
        setError("缺少授权码");
        return;
      }
      try {
        const res = await api<{ session: string; tenant?: { onboardingCompleted?: boolean } }>(
          "/api/auth/sso/oidc/callback",
          { method: "POST", json: { code, state } },
        );
        setSession(res.session);
        router.replace(res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, router]);

  if (!error) return <PageLoading />;
  return (
    <AuthScreen title="登录未完成" description={error}>
      <Button size="lg" className="w-full" variant="outline" nativeButton={false} render={<Link href="/login" />}>
        返回登录
      </Button>
    </AuthScreen>
  );
}

export default function OidcSsoCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Inner />
    </Suspense>
  );
}
