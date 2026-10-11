"use client";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/project-execution";
export function Status({ value }: { value: string }) {
  const variant = [
    "completed",
    "passed",
    "approved",
    "applied",
    "confirmed",
  ].includes(value)
    ? "success"
    : [
          "failed",
          "error",
          "rejected",
          "cancelled",
          "verification_failed",
        ].includes(value)
      ? "danger"
      : [
            "unknown",
            "waiting_review",
            "waiting_approval",
            "pending_approval",
            "conflicted",
          ].includes(value)
        ? "warn"
        : "secondary";
  return <Badge variant={variant}>{statusLabel(value)}</Badge>;
}
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}
export function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`h-9 rounded-lg border bg-background px-2 text-sm ${props.className ?? ""}`}
    />
  );
}
export function Code({
  value,
  limit = 12000,
}: {
  value: unknown;
  limit?: number;
}) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
      {(text ?? "").slice(0, limit)}
      {text && text.length > limit ? "\n[显示已截断]" : ""}
    </pre>
  );
}
export function ErrorNotice({ message }: { message: string | null }) {
  return message ? (
    <div
      role="alert"
      className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {message}
    </div>
  ) : null;
}
