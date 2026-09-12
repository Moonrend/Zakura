"use client";

import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { BrandMark } from "@/components/brand-mark";
import { Label } from "@/components/ui/label";

export function AuthScreen({
  title,
  description,
  children,
  footer,
  showBrand = true,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  showBrand?: boolean;
}) {
  return (
    <div className="relative grid min-h-svh place-items-center p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[400px] animate-in-page">
        {showBrand ? <BrandMark className="mb-8" iconClassName="size-8" /> : null}
        {title ? (
          <div className={showBrand ? "mb-6" : "mb-8"}>
            <h1 className="font-heading text-[28px] font-semibold leading-tight tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1.5 text-[17px] leading-snug text-muted-foreground">{description}</p>
            ) : null}
          </div>
        ) : null}
        {children}
        {footer}
      </div>
    </div>
  );
}

export function AuthFooter({ children }: { children: ReactNode }) {
  return <p className="mt-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function AuthField({
  label,
  htmlFor,
  action,
  children,
}: {
  label: string;
  htmlFor?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}
