"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api, setSession, type PlatformInfo } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [zerocatEnabled, setZerocatEnabled] = useState(false);

  useEffect(() => {
    void api<PlatformInfo>("/api/platform")
      .then((p) => {
        setRegistrationEnabled(!!(p.registrationEnabled || p.edition === "saas"));
        setZerocatEnabled(!!p.oauthProviders?.some((x) => x.id === "zerocat" && x.enabled));
      })
      .catch(() => undefined);
  }, []);

  async function startZerocat() {
    setOauthLoading(true);
    try {
      const res = await api<{ authorizeUrl: string }>("/api/auth/oauth/zerocat/start", {
        method: "POST",
      });
      window.location.href = res.authorizeUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setOauthLoading(false);
    }
  }

  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px] animate-in-page">
        <div className="mb-8 text-center">
          <div className="text-xl font-semibold tracking-tight">Zakura</div>
          <p className="mt-1.5 text-sm text-muted-foreground">登录以继续</p>
        </div>
        {zerocatEnabled ? (
          <div className="mb-6 space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={oauthLoading}
              onClick={() => void startZerocat()}
            >
              {oauthLoading ? <Loader2 className="animate-spin" /> : null}
              {oauthLoading ? "跳转中…" : "使用 ZeroCat 登录"}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              <span>或使用邮箱</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </div>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              const res = await api<{ session: string }>("/api/auth/login", {
                method: "POST",
                json: { email, password },
              });
              setSession(res.session);
              toast.success("登录成功");
              const current = await api<{ onboardingCompleted?: boolean }>("/api/tenant/current");
              router.push(
                current.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents",
              );
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "登录中…" : "继续"}
          </Button>
        </form>
        {registrationEnabled ? (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            没有账号？{" "}
            <Link href="/register" className="text-foreground underline-offset-4 hover:underline">
              注册
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
