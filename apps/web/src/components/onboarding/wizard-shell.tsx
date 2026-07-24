"use client";

import { type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";

export type WizardStepMeta = {
  id: string;
  title: string;
  description?: string;
  optional?: boolean;
};

type OnboardingWizardShellProps = {
  steps: WizardStepMeta[];
  currentIndex: number;
  doneMap: Record<string, boolean>;
  onSelectStep: (index: number) => void;
  onBack: () => void;
  onNext: () => void;
  onSkipAll: () => void;
  onComplete: () => void;
  /** 当前步是否需要页脚「下一步」（动作未自动前进时） */
  showNext?: boolean;
  busy?: boolean;
  children: ReactNode;
};

export function OnboardingWizardShell({
  steps,
  currentIndex,
  doneMap,
  onSelectStep,
  onBack,
  onNext,
  onSkipAll,
  onComplete,
  showNext = false,
  busy,
  children,
}: OnboardingWizardShellProps) {
  const step = steps[currentIndex];
  const progressPct = ((currentIndex + 1) / steps.length) * 100;
  const isLast = currentIndex >= steps.length - 1;
  const canBack = currentIndex > 0;

  return (
    <div className="relative min-h-svh bg-background">
      <div className="absolute inset-x-0 top-0 z-20">
        <ProgressLinear flush value={progressPct} className="bg-border/40" />
      </div>
      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-svh max-w-3xl flex-col px-6 py-14 sm:py-16">
        <header className="mb-8">
          <p className="text-xs text-muted-foreground">
            {currentIndex + 1} / {steps.length}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            {step?.title}
          </h1>
          {step?.description ? (
            <p className="mt-1.5 text-sm text-muted-foreground">{step.description}</p>
          ) : null}
          <nav className="mt-5 flex flex-wrap gap-1.5" aria-label="步骤">
            {steps.map((s, i) => {
              const done = !!doneMap[s.id];
              const active = i === currentIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectStep(i)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border text-[11px] transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : done
                        ? "border-foreground/30 text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/40",
                  )}
                  title={s.title}
                >
                  {done && !active ? <Check className="size-3" /> : i + 1}
                </button>
              );
            })}
          </nav>
        </header>

        <main className="min-h-0 flex-1">{children}</main>

        <footer className="mt-10 flex items-center justify-between gap-3">
          <div>
            {canBack ? (
              <Button variant="ghost" disabled={busy} onClick={onBack}>
                <ChevronLeft className="size-3.5" />
                上一步
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={onSkipAll}>
                稍后再说
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {step?.optional && !isLast ? (
              <Button variant="ghost" disabled={busy} onClick={onNext}>
                跳过
              </Button>
            ) : null}
            {isLast ? (
              <Button disabled={busy} onClick={onComplete}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                完成
              </Button>
            ) : showNext ? (
              <Button disabled={busy} onClick={onNext}>
                下一步
                <ChevronRight className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
