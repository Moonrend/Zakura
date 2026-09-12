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

function ForgotInner() {
  const preset = useSearchParams().get("email") ?? "";
  const [email, setEmail] = useState(preset);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const back = email.trim() ? `/login?email=${encodeURIComponent(email.trim())}` : "/login";

  return (
    <AuthScreen
      title={sent ? "查收邮件" : "重置密码"}
      description={
        sent
          ? "如果该邮箱已注册，我们会寄出重置链接。没收到就检查垃圾箱。"
          : "输入邮箱，我们会寄出重置链接。"
      }
      footer={
        <AuthFooter>
          <Link href={back} className="text-foreground underline-offset-4 hover:underline">
            返回登录
          </Link>
        </AuthFooter>
      }
    >
      {sent ? null : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              await api("/api/auth/forgot-password", { method: "POST", json: { email } });
              setSent(true);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <AuthField label="邮箱" htmlFor="email">
            <Input
              id="email"
              className="h-9"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </AuthField>
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "发送中…" : "发送链接"}
          </Button>
        </form>
      )}
    </AuthScreen>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ForgotInner />
    </Suspense>
  );
}
