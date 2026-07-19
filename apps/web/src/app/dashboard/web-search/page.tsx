"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function WebSearchRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/web");
  }, [router]);
  return null;
}
