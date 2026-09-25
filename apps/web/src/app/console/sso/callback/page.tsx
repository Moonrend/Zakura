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
    const ticket = params.get("ticket");
    void (async () => {
      if (!ticket) {
        setError("缺少票据");
        return;
      }
      try {
        const res = await api<{ session: string; next?: string }>("/api/auth/sso/ticket", {
          method: "POST",
          json: { ticket },
        });
        setSession(res.session);
        router.replace(res.next || "/dashboard/agents");
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

export default function SsoTicketCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Inner />
    </Suspense>
  );
}
