"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type PlatformInfo, setSession } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const platform = await api<PlatformInfo>("/api/platform");
        if (!platform.setupCompleted) {
          router.replace("/setup");
          return;
        }
        const session = localStorage.getItem("zakura_session");
        if (!session) {
          router.replace("/login");
          return;
        }
          try {
          await api("/api/me");
          const current = await api<{ onboardingCompleted?: boolean }>("/api/tenant/current");
          if (current.onboardingCompleted === false) {
            router.replace("/onboarding");
          } else {
            router.replace("/dashboard/agents");
          }
        } catch {
          setSession(null);
          router.replace("/login");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [router]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-sm">
        <div className="space-y-1 text-center">
          <p className="font-medium">无法连接 API</p>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return <div className="min-h-screen bg-background" />;
}
