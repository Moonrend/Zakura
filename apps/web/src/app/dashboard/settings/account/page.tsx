"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/progress-linear";
import { UserAvatar, compressAvatarFile } from "@/components/user-avatar";

type Me = {
  user: {
    id: string;
    email: string;
    name: string | null;
    emailVerified?: boolean;
    totpEnabled?: boolean;
    avatarRev?: number;
  };
};

type Mfa = {
  totp: boolean;
  webauthn: boolean;
  credentials: Array<{ id: string; name: string | null; createdAt: string }>;
};

type SessionRow = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
};

export default function AccountSettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const [meRes, mfaRes, sessRes] = await Promise.all([
      api<Me>("/api/me"),
      api<Mfa>("/api/me/mfa"),
      api<{ sessions: SessionRow[] }>("/api/me/sessions"),
    ]);
    setMe(meRes);
    setName(meRes.user.name ?? "");
    setMfa(mfaRes);
    setSessions(sessRes.sessions);
  }, []);

  useEffect(() => {
    void load().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  if (!me || !mfa) return <PageLoading />;

  return (
    <div className="space-y-5">
      <SettingsHeader title="账户" description="邮箱、密码、多因素认证与登录会话" />

      <SettingsSection title="资料">
        <SettingsField label="头像">
          <div className="flex items-center gap-3">
            <UserAvatar
              userId={me.user.id}
              name={me.user.name}
              email={me.user.email}
              avatarRev={me.user.avatarRev ?? 0}
              size="lg"
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.onchange = async () => {
                      const file = input.files?.[0];
                      if (!file) return;
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
                          prev
                            ? { ...prev, user: { ...prev.user, avatarRev: data.avatarRev ?? Date.now() } }
                            : prev,
                        );
                        toast.success("头像已更新");
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : String(err));
                      }
                    };
                    input.click();
                  }}
                >
                  上传
                </Button>
                {me.user.avatarRev ? (
                  <Button
                    size="sm"
                    variant="ghost"
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
              <p className="text-xs text-muted-foreground">
                未上传时用 GitHub 风格格子头像。上传后会裁成方图。
              </p>
            </div>
          </div>
        </SettingsField>
        <SettingsField label="邮箱">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{me.user.email}</span>
            {me.user.emailVerified ? (
              <span className="text-xs text-muted-foreground">已验证</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const res = await api<{ sent: boolean }>("/api/me/verify-email", { method: "POST" });
                  toast.success(res.sent ? "验证邮件已发送" : "系统邮件未配置，请联系管理员");
                }}
              >
                发送验证邮件
              </Button>
            )}
          </div>
        </SettingsField>
        <SettingsField label="显示名">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
            <Button
              size="sm"
              onClick={async () => {
                await api("/api/me", { method: "PATCH", json: { name } });
                toast.success("已保存");
              }}
            >
              保存
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="密码">
        <SettingsField label="当前密码">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </SettingsField>
        <SettingsField label="新密码">
          <div className="flex gap-2">
            <Input type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api("/api/me/password", {
                    method: "POST",
                    json: { currentPassword, newPassword },
                  });
                  setCurrentPassword("");
                  setNewPassword("");
                  toast.success("密码已更新，其他设备需重新登录");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              更新
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="验证器 (TOTP)">
        {mfa.totp ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">已启用。禁用需要输入当前验证码。</p>
            <div className="flex gap-2">
              <Input placeholder="6 位验证码" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await api("/api/me/mfa/totp/disable", { method: "POST", json: { code: totpCode } });
                    setTotpCode("");
                    await load();
                    toast.success("已关闭验证器");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                禁用
              </Button>
            </div>
          </div>
        ) : totpSecret ? (
          <div className="space-y-2 text-sm">
            <p>在验证器中添加密钥：<code className="break-all">{totpSecret.secret}</code></p>
            <div className="flex gap-2">
              <Input placeholder="6 位验证码" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const res = await api<{ recoveryCodes: string[] }>("/api/me/mfa/totp/enable", {
                      method: "POST",
                      json: { code: totpCode },
                    });
                    setRecovery(res.recoveryCodes);
                    setTotpSecret(null);
                    await load();
                    toast.success("已启用验证器");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                启用
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setTotpSecret(await api("/api/me/mfa/totp/start", { method: "POST" }));
            }}
          >
            绑定验证器
          </Button>
        )}
        {recovery ? (
          <div className="rounded-lg border p-3 text-xs">
            <p className="mb-2 font-medium">请立即保存恢复码，只显示一次：</p>
            <ul className="grid grid-cols-2 gap-1 font-mono">{recovery.map((code) => <li key={code}>{code}</li>)}</ul>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="通行密钥">
        <div className="space-y-2">
          {mfa.credentials.map((cred) => (
            <div key={cred.id} className="flex items-center justify-between text-sm">
              <span>{cred.name || "Passkey"}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api(`/api/me/mfa/webauthn/${cred.id}`, { method: "DELETE" });
                  await load();
                }}
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                const { startRegistration } = await import("@simplewebauthn/browser");
                const options = await api<Record<string, unknown>>(
                  "/api/me/mfa/webauthn/register/options",
                  { method: "POST" },
                );
                const response = await startRegistration({ optionsJSON: options } as never);
                await api("/api/me/mfa/webauthn/register", { method: "POST", json: { response, name: "Passkey" } });
                await load();
                toast.success("已添加通行密钥");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            添加通行密钥
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="登录会话"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await api("/api/me/sessions/revoke-others", { method: "POST" });
              await load();
              toast.success("已登出其他设备");
            }}
          >
            登出其他设备
          </Button>
        }
      >
        <div className="space-y-2">
          {sessions.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 text-sm">
              <div>
                <div>{row.current ? "当前设备" : row.userAgent || "未知设备"}</div>
                <div className="text-xs text-muted-foreground">{row.ip} · {new Date(row.createdAt).toLocaleString()}</div>
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
                  吊销
                </Button>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
