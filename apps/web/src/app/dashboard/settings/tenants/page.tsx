"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type TenantItem = {
  role: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    onboardingCompleted: boolean;
  };
};

export default function TeamsSettingsPage() {
  const router = useRouter();
  const [list, setList] = useState<TenantItem[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [multiTenant, setMultiTenant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantsRes, platform] = await Promise.all([
        api<{
          currentTenantId: string;
          tenants: TenantItem[];
          multiTenant?: boolean;
        }>("/api/tenants"),
        api<{ multiTenant?: boolean }>("/api/platform"),
      ]);
      const enabled = !!(platform.multiTenant ?? tenantsRes.multiTenant);
      setMultiTenant(enabled);
      if (!enabled) {
        router.replace("/dashboard/settings/team");
        return;
      }
      setList(tenantsRes.tenants);
      setCurrentId(tenantsRes.currentTenantId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTo(tenantId: string) {
    if (tenantId === currentId) return;
    setBusy(true);
    try {
      const res = await api<{ session: string; tenant: { onboardingCompleted?: boolean } }>(
        "/api/auth/switch-tenant",
        { method: "POST", json: { tenantId } },
      );
      setSession(res.session);
      toast.success("已切换团队");
      router.push(
        res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createTenant() {
    if (!name.trim()) {
      toast.error("请填写名称");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ session: string }>("/api/tenants", {
        method: "POST",
        json: { name: name.trim() },
      });
      setSession(res.session);
      toast.success("团队已创建");
      setOpen(false);
      router.push("/onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (!multiTenant) return null;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="所有团队"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" />
            新建团队
          </Button>
        }
      />

      <SettingsSection title="团队列表">
        <ul className="divide-y rounded-lg border">
          {list.map((item) => (
            <li
              key={item.tenant.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{item.tenant.name}</span>
                  {item.tenant.id === currentId ? (
                    <Badge variant="secondary">当前</Badge>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.tenant.slug} · {item.role}
                  {!item.tenant.onboardingCompleted ? " · 未完成引导" : ""}
                </div>
              </div>
              <div className="flex gap-2">
                {!item.tenant.onboardingCompleted ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={<Link href="/onboarding" />}
                  >
                    继续引导
                  </Button>
                ) : null}
                {item.tenant.id !== currentId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void switchTo(item.tenant.id)}
                  >
                    切换
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建团队</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="tenant-name">团队名称</Label>
            <Input
              id="tenant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 Acme"
            />
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={() => void createTenant()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              创建并进入引导
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
