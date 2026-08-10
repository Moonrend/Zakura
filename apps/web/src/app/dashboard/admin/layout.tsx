"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useMe } from "@/components/me-context";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 超管后台守卫。二级侧边栏由 AppSidebar 根据路径切换，这里只负责鉴权。
 * SaaS-only — stripped from OSS builds.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useMe();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!me.multiTenant || !me.isPlatformAdmin) {
      toast.error("超级管理后台仅在 SaaS 多团队部署下可用");
      router.replace("/dashboard/agents");
      return;
    }
    setAllowed(true);
  }, [me.isPlatformAdmin, me.multiTenant, router]);

  if (!allowed) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return <>{children}</>;
}
