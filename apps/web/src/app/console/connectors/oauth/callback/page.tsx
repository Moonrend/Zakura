"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    const errDesc = params.get("error_description");

    void (async () => {
      if (err || !code || !state) {
        setError(errDesc || err || "缺少授权码");
        return;
      }
      try {
        await api<{ ok: true; ref: string; profileKey: string; agentId: string }>(
          "/api/connectors/oauth/complete",
          { method: "POST", json: { code, state } },
        );
        toast.success("授权完成");
        router.replace("/dashboard/connectors?oauth=1");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, router]);

  if (!error) return <PageLoading />;

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="w-full max-w-xs space-y-5 animate-in-page text-center">
        <div className="flex items-center justify-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-destructive/30 text-destructive">
            <X className="size-4" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/dashboard/connectors" />}
        >
          返回连接器
        </Button>
      </div>
    </div>
  );
}

export default function ConnectorOauthCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CallbackInner />
    </Suspense>
  );
}
