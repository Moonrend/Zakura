"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { AuthField, AuthFooter, AuthScreen } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/progress-linear";

function ResetInner() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <AuthScreen
      title={done ? "密码已更新" : "设置新密码"}
      description={done ? "请用新密码重新登录。" : "至少 8 位。改完后其他设备会退出。"}
      footer={
        <AuthFooter>
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            返回登录
          </Link>
        </AuthFooter>
      }
    >
      {done ? (
        <Button size="lg" className="w-full" nativeButton={false} render={<Link href="/login" />}>
          去登录
        </Button>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              await api("/api/auth/reset-password", { method: "POST", json: { token, password } });
              setDone(true);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <AuthField label="新密码" htmlFor="password">
            <Input
              id="password"
              className="h-9"
              type="password"
              minLength={8}
              autoComplete="new-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </AuthField>
          <Button type="submit" size="lg" className="w-full" disabled={loading || !token}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "保存中…" : "保存"}
          </Button>
        </form>
      )}
    </AuthScreen>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ResetInner />
    </Suspense>
  );
}
