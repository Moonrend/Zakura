"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";

/** 注册收进登录页。旧链接转到 /login?mode=register。 */
export default function RegisterPage() {
  const router = useRouter();
  useEffect(() => {
    const email = new URLSearchParams(window.location.search).get("email")?.trim();
    const next = email
      ? `/login?mode=register&email=${encodeURIComponent(email)}`
      : "/login?mode=register";
    router.replace(next);
  }, [router]);
  return <PageLoading />;
}
