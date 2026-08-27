"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/otel";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError("client.react", error, { kind: "next-error" });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[40vh] max-w-lg flex-col items-start justify-center gap-3 px-6">
      <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">页面出错了</h1>
      <p className="text-sm text-muted-foreground">{error.message || "未知错误"}</p>
      <Button type="button" onClick={() => reset()}>
        重试
      </Button>
    </div>
  );
}
