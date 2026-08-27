"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type InviteInfo = {
  email: string;
  role: string;
  expiresAt: string;
  tenant: { name: string; slug: string };
};

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [meEmail, setMeEmail] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await api<InviteInfo>(`/api/invites/${token}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const me = await api<{ user: { email: string } }>("/api/me");
        setMeEmail(me.user.email);
      } catch {
        setMeEmail(null);
      }
    })();
  }, [token]);

  async function accept() {
    setBusy(true);
    try {
      const res = await api<{
        session: string;
        tenant: { onboardingCompleted?: boolean };
      }>(`/api/invites/${token}/accept`, {
        method: "POST",
        json: meEmail
          ? {}
          : { email: info?.email, password, name: name || undefined },
      });
      setSession(res.session);
      toast.success("已加入团队");
      router.push(
        res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[380px] space-y-5 animate-in-page">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">加入团队</h1>
          <p className="mt-1 text-sm text-muted-foreground">接受邀请成为团队成员</p>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : !info ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="rounded-md border px-3 py-3 text-sm">
              <div className="text-muted-foreground">团队</div>
              <div className="font-medium">{info.tenant.name}</div>
              <div className="mt-2 text-muted-foreground">邀请邮箱</div>
              <div className="font-medium">{info.email}</div>
              <div className="mt-2 text-muted-foreground">角色</div>
              <div className="font-medium">{info.role}</div>
            </div>

            {meEmail && meEmail.toLowerCase() === info.email.toLowerCase() ? (
              <p className="text-xs text-muted-foreground">已登录为 {meEmail}，可直接接受邀请。</p>
            ) : meEmail ? (
              <div className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
                当前登录账号（{meEmail}）与邀请邮箱不一致。请退出后使用 {info.email} 接受，或注册该邮箱。
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name">显示名称</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="可选"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">设置或输入密码</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    若账号已存在则验证密码；否则将创建新账号。
                  </p>
                </div>
              </div>
            )}

            <Button
              className="w-full"
              disabled={busy || (!!meEmail && meEmail.toLowerCase() !== info.email.toLowerCase())}
              onClick={() => void accept()}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              接受邀请
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
