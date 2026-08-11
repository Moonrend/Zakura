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
import { BrandMark } from "@/components/brand-mark";

type OauthProvider = { id: string; name: string; enabled: boolean };

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OauthProvider[]>([]);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [platformReady, setPlatformReady] = useState(false);
  const [suspendNotice, setSuspendNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("suspended") !== "1") return;
    const reason = params.get("reason")?.trim();
    setSuspendNotice(reason || "账号或所在团队已被封禁");
  }, []);

  useEffect(() => {
    void api<PlatformInfo>("/api/platform")
      .then((p) => {
        setOauthProviders((p.oauthProviders ?? []).filter((x) => x.enabled));
        const pwd = p.passwordLoginEnabled !== false;
        setPasswordLoginEnabled(pwd);
        setRegistrationEnabled(!!(p.registrationEnabled || (p.edition === "saas" && pwd)));
      })
      .catch(() => undefined)
      .finally(() => setPlatformReady(true));
  }, []);

  async function startOauth(providerId: string) {
    setOauthLoading(providerId);
    try {
      const res = await api<{ authorizeUrl: string }>(
        `/api/auth/oauth/${encodeURIComponent(providerId)}/start`,
        { method: "POST" },
      );
      window.location.href = res.authorizeUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setOauthLoading(null);
    }
  }

  const showPasswordForm = passwordLoginEnabled;
  const hasOauth = oauthProviders.length > 0;
  const oauthOnly = hasOauth && !passwordLoginEnabled;

  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px] animate-in-page">
        <div className="mb-10 text-center">
          <BrandMark className="justify-center" iconClassName="size-9" />
        </div>
        {!platformReady ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            {suspendNotice ? (
              <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                {suspendNotice}
              </div>
            ) : null}
            {hasOauth ? (
              <div className={showPasswordForm ? "mb-6 space-y-3" : "space-y-3"}>
                {oauthProviders.map((p, i) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant={oauthOnly && i === 0 ? "default" : "outline"}
                    className="w-full"
                    disabled={!!oauthLoading}
                    onClick={() => void startOauth(p.id)}
                  >
                    {oauthLoading === p.id ? <Loader2 className="animate-spin" /> : null}
                    {oauthLoading === p.id ? "跳转中…" : `使用 ${p.name} 登录`}
                  </Button>
                ))}
                {showPasswordForm ? (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    <span>或使用邮箱</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
              </div>
            ) : null}
            {showPasswordForm ? (
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
                    const current = await api<{ onboardingCompleted?: boolean }>(
                      "/api/tenant/current",
                    );
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
            ) : null}
            {!hasOauth && !showPasswordForm ? (
              <p className="text-center text-sm text-muted-foreground">暂无可用的登录方式</p>
            ) : null}
            {registrationEnabled && showPasswordForm ? (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                没有账号？{" "}
                <Link href="/register" className="text-foreground underline-offset-4 hover:underline">
                  注册
                </Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
