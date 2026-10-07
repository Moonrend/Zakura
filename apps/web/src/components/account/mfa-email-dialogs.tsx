"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function errMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function EmailMfaEnrollDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"intro" | "verify">("intro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!open) {
      setStep("intro");
      setBusy(false);
      setError(null);
      setCode("");
      setSeconds(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || step !== "verify" || seconds <= 0) return;
    const id = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [open, step, seconds]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/email/start", { method: "POST" });
      setStep("verify");
      setSeconds(60);
      setCode("");
      toast.success("验证码已发送到邮箱");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const value = code.replace(/\D/g, "");
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/email/enable", { method: "POST", json: { code: value } });
      onOpenChange(false);
      onDone();
      toast.success("邮箱验证码已启用");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>启用邮箱验证码</DialogTitle>
          <DialogDescription>
            {step === "intro"
              ? "登录时会把 6 位验证码发到你的邮箱，输入后完成第二因素。"
              : "验证码 10 分钟内有效。输入邮箱里收到的 6 位数字。"}
          </DialogDescription>
        </DialogHeader>

        {step === "verify" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email-enroll-code">6 位验证码</Label>
              <Input
                id="email-enroll-code"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="h-10 text-center font-mono text-lg tracking-[0.4em]"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={seconds > 0 || busy}
              onClick={() => void send()}
            >
              {seconds > 0 ? `${seconds}s 后可重新发送` : "重新发送验证码"}
            </button>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {step === "intro" ? (
            <Button disabled={busy} onClick={() => void send()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              发送验证码
            </Button>
          ) : (
            <Button disabled={busy || code.length !== 6} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              验证并启用
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EmailMfaDisableDialog({
  open,
  onOpenChange,
  onDone,
  hasTotp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  hasTotp: boolean;
}) {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [value, setValue] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("totp");
      setValue("");
      setEmailCode("");
      setSent(false);
      setSeconds(0);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !sent || seconds <= 0) return;
    const id = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [open, sent, seconds]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/email/challenge", { method: "POST" });
      setSent(true);
      setSeconds(60);
      setEmailCode("");
      toast.success("验证码已发送到邮箱");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    const body = hasTotp
      ? mode === "recovery"
        ? { recoveryCode: value.trim() }
        : { totp: value.trim() }
      : { emailCode: emailCode.trim() };
    if (hasTotp ? value.trim().length < 6 : emailCode.trim().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/email/disable", { method: "POST", json: body });
      onOpenChange(false);
      onDone();
      toast.success("已关闭邮箱验证码");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>关闭邮箱验证码</DialogTitle>
          <DialogDescription>
            {hasTotp ? "关闭后，登录时不再发送邮箱验证码。" : "关闭前需要验证邮箱。我们会把 6 位验证码发到你的邮箱。"}
          </DialogDescription>
        </DialogHeader>

        {hasTotp ? (
          <div className="space-y-3">
            <div className="flex gap-3 text-sm">
              <button
                type="button"
                className={mode === "totp" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                onClick={() => {
                  setMode("totp");
                  setValue("");
                  setError(null);
                }}
              >
                验证码
              </button>
              <button
                type="button"
                className={mode === "recovery" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                onClick={() => {
                  setMode("recovery");
                  setValue("");
                  setError(null);
                }}
              >
                恢复码
              </button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-disable-totp">{mode === "recovery" ? "恢复码" : "6 位验证码"}</Label>
              <Input
                id="email-disable-totp"
                autoFocus
                autoComplete={mode === "totp" ? "one-time-code" : "off"}
                inputMode={mode === "totp" ? "numeric" : "text"}
                className="font-mono tracking-wide"
                value={value}
                onChange={(e) => setValue(mode === "totp" ? e.target.value.replace(/\D/g, "").slice(0, 6) : e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          </div>
        ) : sent ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email-disable-code">6 位验证码</Label>
              <Input
                id="email-disable-code"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="h-10 text-center font-mono text-lg tracking-[0.4em]"
                placeholder="000000"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={seconds > 0 || busy}
              onClick={() => void send()}
            >
              {seconds > 0 ? `${seconds}s 后可重新发送` : "重新发送验证码"}
            </button>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {hasTotp ? (
            <Button variant="destructive" disabled={busy || value.trim().length < 6} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              关闭邮箱验证码
            </Button>
          ) : sent ? (
            <Button variant="destructive" disabled={busy || emailCode.trim().length !== 6} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              关闭邮箱验证码
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void send()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              发送验证码
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MfaDisableConfirmDialog({
  open,
  onOpenChange,
  onDone,
  hasTotp,
  hasEmail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  hasTotp: boolean;
  hasEmail: boolean;
}) {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [value, setValue] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("totp");
      setValue("");
      setEmailCode("");
      setSent(false);
      setSeconds(0);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !sent || seconds <= 0) return;
    const id = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [open, sent, seconds]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/email/challenge", { method: "POST" });
      setSent(true);
      setSeconds(60);
      setEmailCode("");
      toast.success("验证码已发送到邮箱");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    const body: Record<string, unknown> = { enabled: false };
    if (hasTotp) {
      const trimmed = value.trim();
      if (trimmed.length < 6) return;
      if (mode === "recovery") body.recoveryCode = trimmed;
      else body.totp = trimmed;
    } else if (hasEmail) {
      const trimmed = emailCode.trim();
      if (trimmed.length !== 6) return;
      body.emailCode = trimmed;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/enabled", { method: "PUT", json: body });
      onOpenChange(false);
      onDone();
      toast.success("已关闭两步验证");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>关闭两步验证</DialogTitle>
          <DialogDescription>
            {hasTotp
              ? "关闭后，登录不再需要额外验证。输入当前验证器上的 6 位数字或一枚恢复码。"
              : hasEmail
                ? "关闭前需要验证邮箱。我们会把 6 位验证码发到你的邮箱。"
                : "关闭后，登录只需要密码。通行密钥仍然可以用来免密登录。"}
          </DialogDescription>
        </DialogHeader>

        {hasTotp ? (
          <div className="space-y-3">
            <div className="flex gap-3 text-sm">
              <button
                type="button"
                className={mode === "totp" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                onClick={() => {
                  setMode("totp");
                  setValue("");
                  setError(null);
                }}
              >
                验证码
              </button>
              <button
                type="button"
                className={mode === "recovery" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                onClick={() => {
                  setMode("recovery");
                  setValue("");
                  setError(null);
                }}
              >
                恢复码
              </button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mfa-disable-totp">{mode === "recovery" ? "恢复码" : "6 位验证码"}</Label>
              <Input
                id="mfa-disable-totp"
                autoFocus
                autoComplete={mode === "totp" ? "one-time-code" : "off"}
                inputMode={mode === "totp" ? "numeric" : "text"}
                className="font-mono tracking-wide"
                value={value}
                onChange={(e) => setValue(mode === "totp" ? e.target.value.replace(/\D/g, "").slice(0, 6) : e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          </div>
        ) : hasEmail ? (
          sent ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="mfa-disable-email-code">6 位验证码</Label>
                <Input
                  id="mfa-disable-email-code"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="h-10 text-center font-mono text-lg tracking-[0.4em]"
                  placeholder="000000"
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                />
              </div>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={seconds > 0 || busy}
                onClick={() => void send()}
              >
                {seconds > 0 ? `${seconds}s 后可重新发送` : "重新发送验证码"}
              </button>
            </div>
          ) : null
        ) : (
          <p className="text-sm font-medium">确认关闭两步验证？</p>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {hasTotp ? (
            <Button variant="destructive" disabled={busy || value.trim().length < 6} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              关闭两步验证
            </Button>
          ) : hasEmail ? (
            sent ? (
              <Button variant="destructive" disabled={busy || emailCode.trim().length !== 6} onClick={() => void submit()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                关闭两步验证
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void send()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                发送验证码
              </Button>
            )
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              关闭两步验证
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
