"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type TenantInfo = {
  id: string;
  slug: string;
  name: string;
  onboardingCompleted: boolean;
  role: string;
};

export default function TenantSettingsPage() {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await api<TenantInfo>("/api/tenant/current");
      setTenant(t);
      setName(t.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const updated = await api<{ name: string }>("/api/tenant/current", {
        method: "PATCH",
        json: { name },
      });
      setTenant((t) => (t ? { ...t, name: updated.name } : t));
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = tenant?.role === "admin" || tenant?.role === "owner";

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="租户设置"
        actions={
          isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/dashboard/settings/members" />}
            >
              成员管理
            </Button>
          ) : null
        }
      />

      {loading || !tenant ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <SettingsSection title="基本信息">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>标识 (slug)</Label>
              <Input value={tenant.slug} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">显示名称</Label>
              <Input
                id="name"
                value={name}
                disabled={!isAdmin}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              你的角色：{tenant.role}
              {!tenant.onboardingCompleted ? (
                <>
                  {" · "}
                  <Link href="/onboarding" className="underline underline-offset-2">
                    继续租户引导
                  </Link>
                </>
              ) : null}
            </div>
            {isAdmin ? (
              <Button disabled={busy || name === tenant.name} onClick={() => void save()}>
                保存
              </Button>
            ) : null}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
