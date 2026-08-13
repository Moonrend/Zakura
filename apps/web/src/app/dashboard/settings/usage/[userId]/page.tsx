"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useMe } from "@/components/me-context";
import { UserUsagePanel } from "@/components/usage/user-usage-panel";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";

export default function TenantUserUsagePage() {
  const params = useParams<{ userId: string }>();
  const userId = params.userId;
  const me = useMe();
  const router = useRouter();
  const saas = me.edition === "saas" || me.multiTenant === true;

  useEffect(() => {
    if (!saas) router.replace("/dashboard/settings/team");
  }, [saas, router]);

  if (!saas) return null;

  return (
    <div className="space-y-4">
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2"
        nativeButton={false}
        render={<Link href="/dashboard/settings/usage" />}
      >
        <ArrowLeft />
        返回成员用量
      </Button>
      <SettingsHeader
        title="用户活动"
        description={<span className="font-mono">{userId}</span>}
      />
      <UserUsagePanel userId={userId} scope="tenant" />
    </div>
  );
}
