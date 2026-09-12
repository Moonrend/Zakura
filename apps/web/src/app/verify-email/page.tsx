"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { AuthFooter, AuthScreen } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";

function VerifyInner() {
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<"loading" | "ok" | "err">("loading");

  useEffect(() => {
    if (!token) {
      setStatus("err");
      return;
    }
    void api("/api/auth/verify-email", { method: "POST", json: { token } })
      .then(() => setStatus("ok"))
      .catch(() => setStatus("err"));
  }, [token]);

  return (
    <AuthScreen
      title={status === "ok" ? "邮箱已验证" : status === "err" ? "链接无效" : "正在验证"}
      description={
        status === "ok"
          ? "可以回去登录了。"
          : status === "err"
            ? "链接无效或已过期，请重新发送验证邮件。"
            : "请稍候。"
      }
      footer={
        status === "loading" ? null : (
          <AuthFooter>
            <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
              返回登录
            </Link>
          </AuthFooter>
        )
      }
    >
      {status === "loading" ? <div className="h-9" /> : (
        <Button size="lg" className="w-full" variant="outline" nativeButton={false} render={<Link href="/login" />}>
          去登录
        </Button>
      )}
    </AuthScreen>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <VerifyInner />
    </Suspense>
  );
}
