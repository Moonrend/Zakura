"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { describeUserAgent, formatWhen } from "@/lib/device-from-ua";
import { EmailMfaDisableDialog, EmailMfaEnrollDialog, MfaDisableConfirmDialog } from "@/components/account/mfa-email-dialogs";
import { PasskeyManagerDialog } from "@/components/account/passkey-manager";
import { RecoveryRotateDialog, TotpDisableDialog, TotpSetupDialog } from "@/components/account/totp-dialogs";
import { SettingsHeader, SettingsRow, SettingsSection } from "@/components/settings-shell";
import { UserAvatar, compressAvatarFile } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { PageLoading } from "@/components/ui/progress-linear";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Me = {
  user: {
    id: string;
    email: string;
    name: string | null;
    title?: string | null;
    bio?: string | null;
    emailVerified?: boolean;
    totpEnabled?: boolean;
    hasPassword?: boolean;
    avatarRev?: number;
  };
};

type Mfa = {
  totp: boolean;
  webauthn: boolean;
  email: boolean;
  enabled: boolean;
  methods: string[];
  credentials: Array<{ id: string; name: string | null; createdAt: string }>;
  policy: string;
  required: boolean;
  totpEnabledAt: string | null;
  emailMfaEnabledAt: string | null;
  recoveryRemaining: number;
  recoveryTotal: number;
};

type SessionRow = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
};

function errMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export default function AccountSettingsPage() {
  const { confirm } = useConfirmDialog();
  const fileRef = useRef<HTMLInputElement>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [bio, setBio] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [totpSetup, setTotpSetup] = useState(false);
  const [totpDisable, setTotpDisable] = useState(false);
  const [recoveryRotate, setRecoveryRotate] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passkeyManagerOpen, setPasskeyManagerOpen] = useState(false);
  const [emailEnrollOpen, setEmailEnrollOpen] = useState(false);
  const [emailDisableOpen, setEmailDisableOpen] = useState(false);
  const [mfaDisableOpen, setMfaDisableOpen] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const load = useCallback(async () => {
    const [meRes, mfaRes, sessRes] = await Promise.all([
      api<Me>("/api/me"),
      api<Mfa>("/api/me/mfa"),
      api<{ sessions: SessionRow[] }>("/api/me/sessions"),
    ]);
    setMe(meRes);
    setName(meRes.user.name ?? "");
    setTitle(meRes.user.title ?? "");
    setBio(meRes.user.bio ?? "");
    setMfa(mfaRes);
    setSessions(sessRes.sessions);
  }, []);

  useEffect(() => {
    void load().catch((err) => toast.error(errMessage(err)));
  }, [load]);

  if (!me || !mfa) return <PageLoading />;

  const dirty =
    name !== (me.user.name ?? "") || title !== (me.user.title ?? "") || bio !== (me.user.bio ?? "");

  async function enableMfa() {
    try {
      await api("/api/me/mfa/enabled", { method: "PUT", json: { enabled: true } });
      await load();
      toast.success("两步验证已开启");
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      await api("/api/me", { method: "PATCH", json: { name, title, bio } });
      setMe((prev) =>
        prev ? { ...prev, user: { ...prev.user, name: name.trim() || null, title: title.trim() || null, bio: bio.trim() || null } } : prev,
      );
      toast.success("资料已保存");
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSavingProfile(false);
    }
  }

  async function uploadAvatar(file: File) {
    setAvatarBusy(true);
    try {
      const blob = await compressAvatarFile(file);
      const token = localStorage.getItem("zakura_session");
      const res = await fetch("/api/me/avatar", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: blob,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; avatarRev?: number };
      if (!res.ok) throw new Error(data.error || "上传失败");
      setMe((prev) =>
        prev ? { ...prev, user: { ...prev.user, avatarRev: data.avatarRev ?? Date.now() } } : prev,
      );
      toast.success("头像已更新");
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="账户"
        description="资料会显示在团队成员主页上。密码和两步验证只对自己可见。"
        actions={
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/dashboard/people/${me.user.id}`} />}>
            查看我的主页
          </Button>
        }
      />

      <SettingsSection title="资料" description="名称、头衔和简介给团队里的人看。">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col items-start gap-2">
            <UserAvatar
              userId={me.user.id}
              name={me.user.name}
              email={me.user.email}
              avatarRev={me.user.avatarRev ?? 0}
              size="xl"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadAvatar(file);
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
                {avatarBusy ? <Loader2 className="animate-spin" /> : null}
                更换头像
              </Button>
              {me.user.avatarRev ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={avatarBusy}
                  onClick={async () => {
                    await api("/api/me/avatar", { method: "DELETE" });
                    setMe((prev) => (prev ? { ...prev, user: { ...prev.user, avatarRev: 0 } } : prev));
                    toast.success("已恢复默认头像");
                  }}
                >
                  恢复默认
                </Button>
              ) : null}
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="account-name">显示名</Label>
                <Input id="account-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-title">头衔</Label>
                <Input
                  id="account-title"
                  value={title}
                  maxLength={80}
                  placeholder="例如：后端"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-bio">简介</Label>
              <Textarea
                id="account-bio"
                value={bio}
                maxLength={280}
                placeholder="一两句介绍自己在做什么"
                onChange={(e) => setBio(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{bio.trim().length}/280</p>
            </div>
            <div className="flex justify-end">
              <Button size="sm" disabled={savingProfile || !dirty} onClick={() => void saveProfile()}>
                {savingProfile ? <Loader2 className="animate-spin" /> : null}
                保存资料
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="邮箱">
        <SettingsRow
          label={me.user.email}
          description={me.user.emailVerified ? "已验证，用于登录和通知。" : "尚未验证。验证后才能接收通知邮件。"}
        >
          {me.user.emailVerified ? (
            <Badge variant="success">已验证</Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={verifyBusy}
              onClick={async () => {
                setVerifyBusy(true);
                try {
                  const res = await api<{ sent: boolean }>("/api/me/verify-email", { method: "POST" });
                  toast.success(res.sent ? "验证邮件已发送" : "系统邮件未配置，请联系管理员");
                } catch (err) {
                  toast.error(errMessage(err));
                } finally {
                  setVerifyBusy(false);
                }
              }}
            >
              {verifyBusy ? <Loader2 className="animate-spin" /> : null}
              发送验证邮件
            </Button>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="密码">
        {me.user.hasPassword === false ? (
          <p className="text-sm text-muted-foreground">这个账号通过单点登录接入，没有登录密码。</p>
        ) : (
          <SettingsRow label="登录密码" description="更改后，其他设备上的会话会立刻失效。">
            <Button size="sm" variant="outline" onClick={() => setPasswordOpen(true)}>
              更改密码
            </Button>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="两步验证"
        description={mfa.enabled ? "登录时需要再验证一次。" : "开启后，登录除密码外还需要额外验证一次。"}
      >
        <SettingsRow
          label="两步验证"
          description={mfa.enabled ? "已开启，登录需要二次验证。" : "已关闭，目前只靠密码登录。"}
        >
          <Switch
            checked={mfa.enabled}
            onCheckedChange={(next) => {
              if (next) void enableMfa();
              else setMfaDisableOpen(true);
            }}
          />
        </SettingsRow>

        <div className="divide-y">
          <SettingsRow
            label="Authenticator App"
            description={mfa.totp
              ? `已启用${mfa.totpEnabledAt ? ` · ${formatWhen(mfa.totpEnabledAt)}` : ""}`
              : "未启用"}
          >
            {mfa.totp ? (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" onClick={() => setTotpSetup(true)}>
                  更换
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setTotpDisable(true)}>
                  禁用
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setTotpSetup(true)}>
                设置
              </Button>
            )}
          </SettingsRow>

          <SettingsRow label="邮箱验证码" description={mfa.email ? "已启用" : "未启用"}>
            {mfa.email ? (
              <Button size="sm" variant="ghost" onClick={() => setEmailDisableOpen(true)}>
                禁用
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEmailEnrollOpen(true)}>
                启用
              </Button>
            )}
          </SettingsRow>

          <SettingsRow
            label="通行密钥"
            description={`已注册 ${mfa.credentials.length} 个 · 免密登录与两步验证通用`}
          >
            <Button size="sm" variant="outline" onClick={() => setPasskeyManagerOpen(true)}>
              管理
            </Button>
          </SettingsRow>

          {mfa.enabled ? (
            <SettingsRow
              label="恢复码"
              description={`剩余 ${mfa.recoveryRemaining} / 共 ${mfa.recoveryTotal || 8}`}
            >
              <Button size="sm" variant="outline" onClick={() => setRecoveryRotate(true)}>
                更换
              </Button>
            </SettingsRow>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="通行密钥"
        description={`设置一次即可用于免密登录；开启两步验证后也可作为验证方式。${mfa.credentials.length > 0 ? `已注册 ${mfa.credentials.length} 个` : ""}`}
      >
        <SettingsRow label="通行密钥">
          <Button size="sm" variant="outline" onClick={() => setPasskeyManagerOpen(true)}>
            管理通行密钥
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="登录会话"
        action={
          sessions.some((row) => !row.current) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const ok = await confirm({
                  title: "登出其他设备？",
                  description: "当前这台设备会留下，其他会话立刻失效。",
                  confirmLabel: "登出其他设备",
                });
                if (!ok) return;
                await api("/api/me/sessions/revoke-others", { method: "POST" });
                await load();
                toast.success("已登出其他设备");
              }}
            >
              登出其他设备
            </Button>
          ) : null
        }
      >
        <div className="divide-y">
          {sessions.map((row) => {
            const device = describeUserAgent(row.userAgent);
            return (
              <div key={row.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span>{device.label}</span>
                    {row.current ? <Badge variant="secondary">当前设备</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[row.ip, formatWhen(row.createdAt)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {row.current ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api(`/api/me/sessions/${row.id}`, { method: "DELETE" });
                      await load();
                    }}
                  >
                    登出
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <TotpSetupDialog open={totpSetup} onOpenChange={setTotpSetup} onDone={() => void load()} />
      <TotpDisableDialog open={totpDisable} onOpenChange={setTotpDisable} onDone={() => void load()} />
      <RecoveryRotateDialog open={recoveryRotate} onOpenChange={setRecoveryRotate} onDone={() => void load()} />
      <EmailMfaEnrollDialog open={emailEnrollOpen} onOpenChange={setEmailEnrollOpen} onDone={() => void load()} />
      <EmailMfaDisableDialog
        open={emailDisableOpen}
        onOpenChange={setEmailDisableOpen}
        onDone={() => void load()}
        hasTotp={mfa.totp}
      />
      <MfaDisableConfirmDialog
        open={mfaDisableOpen}
        onOpenChange={setMfaDisableOpen}
        onDone={() => void load()}
        hasTotp={mfa.totp}
        hasEmail={mfa.email}
      />
      <PasskeyManagerDialog
        open={passkeyManagerOpen}
        onOpenChange={setPasskeyManagerOpen}
        onChanged={() => void load()}
      />
      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}

function PasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShow(false);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (newPassword.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/password", { method: "POST", json: { currentPassword, newPassword } });
      onOpenChange(false);
      toast.success("密码已更新，其他设备需重新登录");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更改密码</DialogTitle>
          <DialogDescription>改完之后，除当前会话外的登录都会失效。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">当前密码</Label>
            <Input
              id="pw-current"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">新密码</Label>
            <Input
              id="pw-new"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">再输入一次新密码</Label>
            <Input
              id="pw-confirm"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShow((v) => !v)}
          >
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {show ? "隐藏密码" : "显示密码"}
          </button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={busy || !currentPassword || !newPassword} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            更新密码
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
