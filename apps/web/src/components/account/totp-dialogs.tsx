"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatTotpSecret, QrSvg } from "@/lib/qr";
import { RecoveryCodesView } from "@/components/account/recovery-codes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

type SetupStep = "intro" | "scan" | "verify" | "recovery";

export function TotpSetupDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<SetupStep>("intro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const started = Boolean(secret) && step !== "recovery";
  const blocking = step === "recovery" && !saved;

  function reset() {
    setStep("intro");
    setBusy(false);
    setError(null);
    setSecret(null);
    setCode("");
    setRecovery(null);
    setSaved(false);
  }

  async function close(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (blocking) return;
    if (started) {
      await api("/api/me/mfa/totp/cancel", { method: "POST" }).catch(() => undefined);
    }
    reset();
    onOpenChange(false);
  }

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ secret: string; otpauthUrl: string }>("/api/me/mfa/totp/start", { method: "POST" });
      setSecret(res);
      setStep("scan");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function enable(nextCode: string) {
    const trimmed = nextCode.replace(/\s+/g, "");
    if (trimmed.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>("/api/me/mfa/totp/enable", {
        method: "POST",
        json: { code: trimmed },
      });
      setRecovery(res.recoveryCodes);
      setCode("");
      setStep("recovery");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    reset();
    onOpenChange(false);
    onDone();
    toast.success("验证器已启用");
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" showCloseButton={!blocking}>
        <DialogHeader>
          <DialogTitle>
            {step === "intro"
              ? "绑定验证器"
              : step === "scan"
                ? "用验证器扫描"
                : step === "verify"
                  ? "输入验证码"
                  : "保存恢复码"}
          </DialogTitle>
          <DialogDescription>
            {step === "intro"
              ? "登录时除了密码，还要输入验证器上的 6 位数字。"
              : step === "scan"
                ? "用 1Password、Google Authenticator 或系统密码应用扫描。扫不了就手动输入密钥。"
                : step === "verify"
                  ? "验证器会每 30 秒刷新一次。输入当前显示的 6 位数字。"
                  : "这些码只显示一次。验证器丢失时，用它们登录。每个只能用一次。"}
          </DialogDescription>
        </DialogHeader>

        {step === "intro" ? (
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>手机或密码管理器里打开验证器，选添加账户。</li>
            <li>扫描二维码或粘贴密钥。</li>
            <li>回来输入 6 位数字完成绑定，并立刻保存恢复码。</li>
          </ul>
        ) : null}

        {step === "scan" && secret ? (
          <div className="space-y-3">
            <QrSvg value={secret.otpauthUrl} label="验证器二维码" className="mx-auto" />
            <div className="space-y-1.5">
              <Label htmlFor="totp-secret">无法扫码时，手动输入</Label>
              <div className="flex gap-2">
                <Input
                  id="totp-secret"
                  readOnly
                  className="font-mono text-xs tracking-wide"
                  value={formatTotpSecret(secret.secret)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(secret.secret);
                    toast.success("密钥已复制");
                  }}
                >
                  复制
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {step === "verify" ? (
          <div className="space-y-1.5">
            <Label htmlFor="totp-enable-code">6 位验证码</Label>
            <Input
              id="totp-enable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={8}
              className="h-10 text-center font-mono text-lg tracking-[0.4em]"
              placeholder="000000"
              value={code}
              onChange={(e) => {
                const next = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(next);
                if (next.length === 6) void enable(next);
              }}
            />
          </div>
        ) : null}

        {step === "recovery" && recovery ? (
          <div className="space-y-3">
            <RecoveryCodesView codes={recovery} />
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={saved} onCheckedChange={(v) => setSaved(Boolean(v))} className="mt-0.5" />
              我已把恢复码存到密码管理器或离线位置
            </label>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          {step === "intro" ? (
            <Button disabled={busy} onClick={() => void begin()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              开始绑定
            </Button>
          ) : null}
          {step === "scan" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void close(false)}>
                取消
              </Button>
              <Button onClick={() => { setError(null); setStep("verify"); }}>已添加到验证器</Button>
            </>
          ) : null}
          {step === "verify" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => { setError(null); setStep("scan"); }}>
                返回
              </Button>
              <Button disabled={busy || code.length !== 6} onClick={() => void enable(code)}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                验证并启用
              </Button>
            </>
          ) : null}
          {step === "recovery" ? (
            <Button disabled={!saved} onClick={finish}>
              完成
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TotpDisableDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("totp");
      setValue("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/totp/disable", {
        method: "POST",
        json: mode === "recovery" ? { recoveryCode: trimmed } : { code: trimmed },
      });
      onOpenChange(false);
      onDone();
      toast.success("已关闭验证器");
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
          <DialogTitle>关闭验证器</DialogTitle>
          <DialogDescription>
            关闭后，下次登录不再需要第二因素。恢复码也会一并作废。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-3 text-sm">
            <button
              type="button"
              className={mode === "totp" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
              onClick={() => { setMode("totp"); setValue(""); setError(null); }}
            >
              验证码
            </button>
            <button
              type="button"
              className={mode === "recovery" ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
              onClick={() => { setMode("recovery"); setValue(""); setError(null); }}
            >
              恢复码
            </button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="totp-disable-code">{mode === "recovery" ? "恢复码" : "6 位验证码"}</Label>
            <Input
              id="totp-disable-code"
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="destructive" disabled={busy || value.trim().length < 6} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            关闭验证器
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RecoveryRotateDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  function reset() {
    setCode("");
    setBusy(false);
    setError(null);
    setRecovery(null);
    setSaved(false);
  }

  async function rotate() {
    const trimmed = code.replace(/\s+/g, "");
    if (trimmed.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>("/api/me/mfa/totp/recovery", {
        method: "POST",
        json: { code: trimmed },
      });
      setRecovery(res.recoveryCodes);
      setCode("");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && recovery && !saved) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!(recovery && !saved)}>
        <DialogHeader>
          <DialogTitle>{recovery ? "保存新的恢复码" : "重新生成恢复码"}</DialogTitle>
          <DialogDescription>
            {recovery
              ? "旧恢复码已作废。把新的码存好，这一屏只出现一次。"
              : "生成后，之前没用过的恢复码立刻失效。需要当前验证器上的 6 位数字。"}
          </DialogDescription>
        </DialogHeader>
        {recovery ? (
          <div className="space-y-3">
            <RecoveryCodesView codes={recovery} />
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={saved} onCheckedChange={(v) => setSaved(Boolean(v))} className="mt-0.5" />
              我已保存新的恢复码
            </label>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="totp-rotate-code">6 位验证码</Label>
            <Input
              id="totp-rotate-code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              className="h-10 text-center font-mono text-lg tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rotate();
              }}
            />
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          {recovery ? (
            <Button
              disabled={!saved}
              onClick={() => {
                reset();
                onOpenChange(false);
                onDone();
                toast.success("恢复码已更新");
              }}
            >
              完成
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
              <Button disabled={busy || code.length !== 6} onClick={() => void rotate()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                生成新恢复码
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
