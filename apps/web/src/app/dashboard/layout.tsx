"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, setSession } from "@/lib/api";
import { MeProvider, type MeInfo } from "@/components/me-context";
import { AppSidebar } from "@/components/app-sidebar";
import { NavigationProgress } from "@/components/navigation-progress";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

type MeResponse = MeInfo & {
  user?: { id: string };
  tenant: MeInfo["tenant"] & { id?: string; onboardingCompleted?: boolean };
};

function shouldForceOnboarding(pathname: string) {
  return (
    !pathname.startsWith("/onboarding") &&
    !pathname.startsWith("/dashboard/settings")
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);

  // 仅挂载时鉴权一次，通过 MeProvider 下发给子页，避免重复打 /api/me
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<MeResponse>("/api/me");
        if (cancelled) return;
        const info: MeInfo = {
          user: res.user?.id ? { id: res.user.id } : undefined,
          tenant: res.tenant,
          isPlatformAdmin: !!res.isPlatformAdmin && !!res.multiTenant,
          multiTenant: !!res.multiTenant,
          role: res.role,
          edition: res.edition,
          canUseLocalRunner: res.canUseLocalRunner !== false,
        };
        setMe(info);
        const completed = res.tenant.onboardingCompleted !== false;
        setOnboardingCompleted(completed);
        if (completed || !shouldForceOnboarding(pathnameRef.current)) {
          setReady(true);
          return;
        }
        const skipped = sessionStorage.getItem("zakura_skip_onboarding");
        if (!skipped) {
          router.replace("/onboarding");
          return;
        }
        setReady(true);
      } catch {
        if (cancelled) return;
        setSession(null);
        router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!ready || onboardingCompleted || !shouldForceOnboarding(pathname)) return;
    const skipped = sessionStorage.getItem("zakura_skip_onboarding");
    if (!skipped) {
      router.replace("/onboarding");
    }
  }, [pathname, ready, onboardingCompleted, router]);

  if (!ready || !me) {
    return (
      <div className="flex min-h-svh">
        <div className="hidden w-64 border-r bg-sidebar p-3 md:block">
          <Skeleton className="mb-4 h-8 w-32" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-6">
          <Skeleton className="mb-4 h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <MeProvider value={me}>
      <SidebarProvider>
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        <AppSidebar
          tenant={me.tenant.name}
          multiTenant={!!me.multiTenant}
          isPlatformAdmin={!!me.isPlatformAdmin}
        />
        <SidebarInset>
          <header className="z-20 shrink-0 border-b border-border/80 bg-background">
            <div className="mx-auto flex h-12 w-full max-w-[var(--content-max)] items-center gap-2 px-4 md:px-6">
              <SidebarTrigger className="-ml-0.5" />
              <div className="min-w-0 truncate text-xs text-muted-foreground">
                {me.tenant.name}
              </div>
            </div>
          </header>
          <div className="scrollbar-subtle scrollbar-gutter-stable min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-[var(--content-max)] px-4 py-5 md:px-6 md:py-6">
              <div key={pathname} className="animate-in-page">
                {children}
              </div>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </MeProvider>
  );
}
