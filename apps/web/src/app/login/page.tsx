"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, ChevronLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, setSession, type PlatformInfo, ApiError } from "@/lib/api";
import { AuthField, AuthFooter, AuthScreen } from "@/components/auth-screen";
import { OauthProviderIcon } from "@/components/oauth-provider-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type OauthProvider = { id: string; name: string; enabled: boolean };
type Mode = "signin" | "register";
type Step = "email" | "password" | "mfa";
type MfaMode = "totp" | "webauthn" | "recovery";
type SsoHint = { protocol: string; tenantSlug?: string };
type Discover = {
  sso?: boolean;
  required?: boolean;
  protocol?: string;
  tenantSlug?: string;
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [step, setStep] = useState<Step>("email");
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [code, setCode] = useState("");
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [mfaMode, setMfaMode] = useState<MfaMode>("totp");
  const [ssoHint, setSsoHint] = useState<SsoHint | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suspendNotice, setSuspendNotice] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OauthProvider[]>([]);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [highlightedMethod, setHighlightedMethod] = useState("auto");
  const [platformReady, setPlatformReady] = useState(false);
  const passkeyTried = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("suspended") === "1") {
      setSuspendNotice(params.get("reason")?.trim() || "账号已被封禁");
    }
    const preset = params.get("email")?.trim();
    if (preset) setEmail(preset);
    if (params.get("mode") === "register") setMode("register");
  }, []);

  useEffect(() => {
    void api<PlatformInfo>("/api/platform")
      .then((p) => {
        setOauthProviders((p.oauthProviders ?? []).filter((x) => x.enabled));
        const pwd = p.passwordLoginEnabled !== false;
        setPasswordLoginEnabled(pwd);
        setRegistrationEnabled(!!(p.registrationEnabled || (p.edition === "saas" && pwd)));
        setHighlightedMethod(p.highlightedLoginMethod || "auto");
        if (!(p.registrationEnabled || (p.edition === "saas" && pwd))) {
          setMode((current) => (current === "register" ? "signin" : current));
        }
      })
      .catch(() => undefined)
      .finally(() => setPlatformReady(true));
  }, []);

  function go(next: Step, back = false) {
    setDir(back ? "back" : "forward");
    setNotice(null);
    setStep(next);
  }

  function backToEmail() {
    setPassword("");
    setCode("");
    setMfaTicket(null);
    setSsoHint(null);
    setShowPassword(false);
    go("email", true);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setStep("email");
    setNotice(null);
    setPassword("");
    setCode("");
    setMfaTicket(null);
    setSsoHint(null);
  }

  async function finishLogin(session: string) {
    setSession(session);
    const current = await api<{ onboardingCompleted?: boolean }>("/api/tenant/current");
    router.push(current.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents");
  }

  async function startSso(hint: SsoHint) {
    setOauthLoading("sso");
    try {
      const res = await api<{ authorizeUrl: string }>(`/api/auth/sso/${hint.protocol}/start`, {
        method: "POST",
        json: { email, tenantSlug: hint.tenantSlug },
      });
      window.location.href = res.authorizeUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setOauthLoading(null);
    }
  }

  async function continueFromEmail() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setLoading(true);
    setNotice(null);
    try {
      const found = await api<Discover>("/api/auth/sso/discover", {
        method: "POST",
        json: { email: trimmed },
      });
      const hint = found.sso && found.protocol
        ? { protocol: found.protocol, tenantSlug: found.tenantSlug }
        : null;
      setSsoHint(hint);

      if (found.required && hint) {
        await startSso(hint);
        return;
      }
      if (found.required && !hint) {
        setNotice("该邮箱需通过公司 SSO 登录，请联系管理员完成配置。");
        return;
      }
      if (hint && !passwordLoginEnabled) {
        await startSso(hint);
        return;
      }
      if (!passwordLoginEnabled && !hint) {
        setNotice(oauthProviders.length ? "请使用上方方式登录。" : "当前没有可用的登录方式，请联系管理员。");
        return;
      }
      go("password");
    } catch {
      if (passwordLoginEnabled) go("password");
      else toast.error("无法确认登录方式，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function submitPassword() {
    setLoading(true);
    try {
      const res = await api<{ session?: string; mfaRequired?: boolean; mfaTicket?: string; methods?: string[] }>(
        "/api/auth/login",
        { method: "POST", json: { email, password } },
      );
      if (res.mfaRequired && res.mfaTicket) {
        const methods = res.methods ?? [];
        setMfaTicket(res.mfaTicket);
        setMfaMethods(methods);
        setMfaMode(methods.includes("webauthn") ? "webauthn" : "totp");
        setCode("");
        passkeyTried.current = false;
        go("mfa");
        setLoading(false);
        return;
      }
      if (!res.session) throw new Error("登录失败");
      await finishLogin(res.session);
    } catch (err) {
      const message =
        err instanceof ApiError && err.body.code === "sso_required"
          ? err.message
          : err instanceof Error ? err.message : String(err);
      toast.error(message);
      setLoading(false);
    }
  }

  async function submitRegister() {
    setLoading(true);
    try {
      const res = await api<{ session: string; next?: string }>("/api/auth/register", {
        method: "POST",
        json: {
          email,
          password,
          name: name || undefined,
          tenantName: tenantName || undefined,
        },
      });
      setSession(res.session);
      toast.success("注册成功");
      router.push(res.next || "/onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  async function completeMfa(extra: Record<string, unknown>) {
    setLoading(true);
    try {
      const res = await api<{ session: string }>("/api/auth/mfa/complete", {
        method: "POST",
        json: { ticket: mfaTicket, ...extra },
      });
      await finishLogin(res.session);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  async function startPasskey() {
    if (!mfaTicket) return;
    setLoading(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const options = await api<Record<string, unknown>>("/api/auth/mfa/webauthn/options", {
        method: "POST",
        json: { ticket: mfaTicket },
      });
      const assertion = await startAuthentication({ optionsJSON: options } as never);
      await completeMfa({ webauthn: assertion });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError") {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    }
  }

  useEffect(() => {
    if (step !== "mfa" || mfaMode !== "webauthn" || passkeyTried.current) return;
    passkeyTried.current = true;
    void startPasskey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mfaMode]);

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

  const orderedOauth = useMemo(() => {
    if (highlightedMethod === "auto" || highlightedMethod === "password") return oauthProviders;
    const hit = oauthProviders.find((p) => p.id === highlightedMethod);
    if (!hit) return oauthProviders;
    return [hit, ...oauthProviders.filter((p) => p.id !== hit.id)];
  }, [oauthProviders, highlightedMethod]);

  const oauthRow = orderedOauth.length > 0 ? (
    <div className="flex gap-2">
      {orderedOauth.map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="secondary"
          className="h-11 flex-1"
          disabled={!!oauthLoading || loading}
          aria-label={`使用 ${p.name} 继续`}
          title={p.name}
          onClick={() => void startOauth(p.id)}
        >
          {oauthLoading === p.id ? <Loader2 className="animate-spin" /> : <OauthProviderIcon id={p.id} />}
        </Button>
      ))}
    </div>
  ) : null;

  const heading =
    mode === "register"
      ? { title: "欢迎使用 Zakura", description: "创建账号。" }
      : { title: "欢迎使用 Zakura", description: "登录以继续。" };

  const busy = loading || !!oauthLoading;

  if (!platformReady) {
    return (
      <AuthScreen showBrand={false} title={heading.title} description={heading.description}>
        <div className="h-32" />
      </AuthScreen>
    );
  }

  const footer =
    mode === "register" ? (
      <AuthFooter>
        已有账号？{" "}
        <button type="button" className="text-foreground underline-offset-4 hover:underline" onClick={() => switchMode("signin")}>
          登录
        </button>
      </AuthFooter>
    ) : step === "email" && registrationEnabled ? (
      <AuthFooter>
        没有账号？{" "}
        <button type="button" className="text-foreground underline-offset-4 hover:underline" onClick={() => switchMode("register")}>
          注册
        </button>
      </AuthFooter>
    ) : null;

  return (
    <AuthScreen showBrand={false} title={heading.title} description={heading.description} footer={footer}>
      {suspendNotice ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {suspendNotice}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
          {notice}
        </div>
      ) : null}

      <div
        key={`${mode}-${step}`}
        className={
          dir === "back"
            ? "onboarding-step-enter onboarding-step-enter-back space-y-5"
            : "onboarding-step-enter onboarding-step-enter-forward space-y-5"
        }
      >
        {mode === "register" ? (
          <>
            {oauthRow}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitRegister();
              }}
            >
              <AuthField label="邮箱" htmlFor="email">
                <Input
                  id="email"
                  className="h-10"
                  type="email"
                  placeholder="你的邮箱"
                  autoComplete="username"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </AuthField>
              <AuthField label="密码" htmlFor="password">
                <div className="relative">
                  <Input
                    id="password"
                    className="h-10 pr-9"
                    type={showPassword ? "text" : "password"}
                    minLength={8}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </AuthField>
              <AuthField label="显示名称" htmlFor="name">
                <Input
                  id="name"
                  className="h-10"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </AuthField>
              <AuthField label="团队名称" htmlFor="tenantName">
                <Input
                  id="tenantName"
                  className="h-10"
                  placeholder="可选，默认用邮箱前缀"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                />
              </AuthField>
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {loading ? <Loader2 className="animate-spin" /> : null}
                {loading ? "创建中…" : "注册"}
              </Button>
            </form>
          </>
        ) : null}

        {mode === "signin" && step === "email" ? (
          <>
            {oauthRow}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void continueFromEmail();
              }}
            >
              <AuthField label="邮箱" htmlFor="email">
                <Input
                  id="email"
                  className="h-10"
                  type="email"
                  placeholder="你的邮箱"
                  autoComplete="username"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </AuthField>
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {loading ? <Loader2 className="animate-spin" /> : null}
                {loading ? "继续…" : "使用邮箱继续"}
              </Button>
            </form>
          </>
        ) : null}

        {mode === "signin" && step === "password" ? (
          <>
            {ssoHint ? (
              <Button
                type="button"
                variant="secondary"
                className="h-10 w-full"
                disabled={busy}
                onClick={() => void startSso(ssoHint)}
              >
                {oauthLoading === "sso" ? <Loader2 className="animate-spin" /> : <Building2 className="size-4" />}
                {oauthLoading === "sso" ? "跳转中…" : "使用公司账号"}
              </Button>
            ) : null}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitPassword();
              }}
            >
              <AuthField
                label="邮箱"
                htmlFor="email"
                action={
                  <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={backToEmail}>
                    更换邮箱
                  </button>
                }
              >
                <Input id="email" className="h-10" type="email" readOnly value={email} />
              </AuthField>
              <AuthField
                label="密码"
                htmlFor="password"
                action={
                  <Link
                    href={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    重置密码
                  </Link>
                }
              >
                <div className="relative">
                  <Input
                    id="password"
                    className="h-10 pr-9"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus
                    required
                    placeholder="密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </AuthField>
              <Button type="submit" className="h-10 w-full" disabled={busy}>
                {loading ? <Loader2 className="animate-spin" /> : null}
                {loading ? "登录中…" : "登录"}
              </Button>
            </form>
            <p className="text-center text-sm">
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={backToEmail}>
                <ChevronLeft className="size-3.5" />
                更换方式
              </button>
            </p>
          </>
        ) : null}

        {mode === "signin" && step === "mfa" ? (
          <>
            {mfaMode === "webauthn" ? (
              <div className="space-y-3">
                <Button type="button" className="h-10 w-full" disabled={loading} onClick={() => void startPasskey()}>
                  {loading ? <Loader2 className="animate-spin" /> : null}
                  {loading ? "等待设备…" : "使用通行密钥"}
                </Button>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
                  {mfaMethods.includes("totp") ? (
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setMfaMode("totp"); setCode(""); }}>
                      改用验证码
                    </button>
                  ) : null}
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setMfaMode("recovery"); setCode(""); }}>
                    使用恢复码
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (mfaMode === "recovery") void completeMfa({ recoveryCode: code });
                  else void completeMfa({ totp: code });
                }}
              >
                <AuthField label={mfaMode === "recovery" ? "恢复码" : "验证码"} htmlFor="mfa-code">
                  <Input
                    id="mfa-code"
                    className="h-10 tracking-widest"
                    inputMode={mfaMode === "totp" ? "numeric" : "text"}
                    autoComplete={mfaMode === "totp" ? "one-time-code" : "off"}
                    autoFocus
                    placeholder={mfaMode === "recovery" ? "恢复码" : "6 位数字"}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </AuthField>
                <Button type="submit" className="h-10 w-full" disabled={loading || code.trim().length < 6}>
                  {loading ? <Loader2 className="animate-spin" /> : null}
                  {loading ? "验证中…" : "验证"}
                </Button>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
                  {mfaMode !== "totp" && mfaMethods.includes("totp") ? (
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setMfaMode("totp"); setCode(""); }}>
                      改用验证码
                    </button>
                  ) : null}
                  {mfaMethods.includes("webauthn") ? (
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setMfaMode("webauthn"); passkeyTried.current = false; }}>
                      改用通行密钥
                    </button>
                  ) : null}
                  {mfaMode !== "recovery" ? (
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setMfaMode("recovery"); setCode(""); }}>
                      使用恢复码
                    </button>
                  ) : null}
                </div>
              </form>
            )}
            <p className="text-center text-sm">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setMfaTicket(null);
                  setCode("");
                  go("password", true);
                }}
              >
                <ChevronLeft className="size-3.5" />
                更换方式
              </button>
            </p>
          </>
        ) : null}
      </div>
    </AuthScreen>
  );
}
