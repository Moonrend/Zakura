"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function WebFetchRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/web");
  }, [router]);
  return null;
}
