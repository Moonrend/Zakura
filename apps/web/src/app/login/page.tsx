"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  const [highlightedMethod, setHighlightedMethod] = useState("auto");
  const [platformReady, setPlatformReady] = useState(false);
  const [suspendNotice, setSuspendNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("suspended") === "1") {
      setSuspendNotice(params.get("reason")?.trim() || "账号已被封禁");
    }
  }, []);

  useEffect(() => {
    void api<PlatformInfo>("/api/platform")
      .then((p) => {
        setOauthProviders((p.oauthProviders ?? []).filter((x) => x.enabled));
        const pwd = p.passwordLoginEnabled !== false;
        setPasswordLoginEnabled(pwd);
        setRegistrationEnabled(!!(p.registrationEnabled || (p.edition === "saas" && pwd)));
        setHighlightedMethod(p.highlightedLoginMethod || "auto");
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

  const orderedOauth = useMemo(() => {
    if (highlightedMethod === "auto" || highlightedMethod === "password") return oauthProviders;
    const hit = oauthProviders.find((p) => p.id === highlightedMethod);
    if (!hit) return oauthProviders;
    return [hit, ...oauthProviders.filter((p) => p.id !== hit.id)];
  }, [oauthProviders, highlightedMethod]);

  const highlightPassword =
    highlightedMethod === "password" ||
    (highlightedMethod === "auto" && showPasswordForm && !hasOauth);

  const highlightOauthId =
    highlightedMethod !== "auto" && highlightedMethod !== "password"
      ? highlightedMethod
      : highlightedMethod === "auto" && hasOauth && !showPasswordForm
        ? orderedOauth[0]?.id
        : null;

  const passwordFirst = highlightPassword && hasOauth && showPasswordForm;

  const passwordForm = showPasswordForm ? (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
          const res = await api<{ session: string }>("/api/auth/login", {
            method: "POST",
            json: { email, password },
          });
          setSession(res.session);
          const current = await api<{ onboardingCompleted?: boolean }>("/api/tenant/current");
          router.push(
            current.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents",
          );
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="email" className="text-xs text-muted-foreground">邮箱</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="password" className="text-xs text-muted-foreground">密码</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        className="w-full"
        variant={highlightPassword ? "default" : "outline"}
        disabled={loading}
      >
        {loading ? "登录中…" : "继续"}
      </Button>
    </form>
  ) : null;

  const oauthBlock = hasOauth ? (
    <div className="space-y-2">
      {orderedOauth.map((p) => {
        const highlighted =
          highlightOauthId === p.id ||
          (highlightedMethod === "auto" && !showPasswordForm && orderedOauth[0]?.id === p.id);
        return (
          <Button
            key={p.id}
            type="button"
            variant={highlighted ? "default" : "outline"}
            className="w-full"
            disabled={!!oauthLoading}
            onClick={() => void startOauth(p.id)}
          >
            {oauthLoading === p.id ? "跳转中…" : `使用 ${p.name} 登录`}
          </Button>
        );
      })}
    </div>
  ) : null;

  const divider = (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{passwordFirst ? "或" : "或"}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );

  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[320px]">
        <div
          className="mb-8 text-center"
          style={{
            opacity: platformReady ? 1 : 0.6,
            transition: "opacity 200ms",
          }}
        >
          <BrandMark className="justify-center" iconClassName="size-8" />
        </div>

        <div
          style={{
            opacity: platformReady ? 1 : 0,
            transform: platformReady ? "translateY(0)" : "translateY(6px)",
            transition: "opacity 220ms, transform 220ms cubic-bezier(0.22,1,0.36,1)",
          }}
        >
          {suspendNotice ? (
            <div className="mb-4 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {suspendNotice}
            </div>
          ) : null}

          {platformReady && (
            <div className="space-y-4">
              {passwordFirst ? (
                <>
                  {passwordForm}
                  {hasOauth ? <>{divider}{oauthBlock}</> : null}
                </>
              ) : (
                <>
                  {oauthBlock}
                  {hasOauth && showPasswordForm ? divider : null}
                  {passwordForm}
                </>
              )}

              {!hasOauth && !showPasswordForm ? (
                <p className="text-center text-xs text-muted-foreground">暂无可用的登录方式</p>
              ) : null}

              {registrationEnabled && showPasswordForm ? (
                <p className="text-center text-xs text-muted-foreground">
                  没有账号？{" "}
                  <Link href="/register" className="text-foreground underline-offset-4 hover:underline">
                    注册
                  </Link>
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
