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

/** SaaS-only public registration. Stripped from OSS builds. */
export default function RegisterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [form, setForm] = useState({
    email: "",
    password: "",
    name: "",
    tenantName: "",
  });

  useEffect(() => {
    void api<PlatformInfo>("/api/platform")
      .then((p) => {
        setAllowed(!!(p.registrationEnabled || p.edition === "saas"));
      })
      .catch(() => setAllowed(false));
  }, []);

  if (allowed === false) {
    return (
      <div className="relative grid min-h-svh place-items-center p-6">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-[360px] text-center">
          <div className="text-xl font-semibold tracking-tight">Zakura</div>
          <p className="mt-2 text-sm text-muted-foreground">
            当前部署为开源单账户版，不支持自助注册。请使用管理员安装流程。
          </p>
          <Button
            className="mt-6"
            variant="outline"
            nativeButton={false}
            render={<Link href="/login" />}
          >
            去登录
          </Button>
        </div>
      </div>
    );
  }

  if (allowed === null) {
    return <div className="min-h-svh bg-background" />;
  }

  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px] animate-in-page">
        <div className="mb-8 text-center">
          <div className="text-xl font-semibold tracking-tight">Zakura</div>
          <p className="mt-1.5 text-sm text-muted-foreground">创建账号并创建工作区</p>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              const res = await api<{ session: string; next?: string }>("/api/auth/register", {
                method: "POST",
                json: {
                  email: form.email,
                  password: form.password,
                  name: form.name || undefined,
                  tenantName: form.tenantName || undefined,
                },
              });
              setSession(res.session);
              toast.success("注册成功");
              router.push(res.next || "/onboarding");
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
              required
              autoComplete="username"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">显示名称</Label>
            <Input
              id="name"
              autoComplete="name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenantName">工作区名称</Label>
            <Input
              id="tenantName"
              placeholder="可选，默认用邮箱前缀"
              value={form.tenantName}
              onChange={(e) => setForm((f) => ({ ...f, tenantName: e.target.value }))}
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "创建中…" : "注册"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          已有账号？{" "}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
