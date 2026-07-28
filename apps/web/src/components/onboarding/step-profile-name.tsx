"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsHeader } from "@/components/settings-shell";

export function StepProfileName({
  busy,
  onBack,
  onContinue,
}: {
  busy?: boolean;
  onBack: () => void;
  onContinue: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const normalizedName = name.trim();
  const leaving = Boolean(busy || submitting);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedName || leaving) return;
    setSubmitting(true);
    try {
      await onContinue(normalizedName);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={leaving} onClick={onBack}>
        <ArrowLeft />
        返回模型配置
      </Button>

      <SettingsHeader title="我该怎么称呼你？" description="你的名字会随第一条消息发送给 Agent。" />

      <form
        className="max-w-md space-y-4 transition-opacity duration-150 ease-out"
        onSubmit={submit}
        aria-busy={leaving}
      >
        <div className="space-y-1.5">
          <Label htmlFor="onboarding-profile-name">名字</Label>
          <Input
            id="onboarding-profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 小林"
            autoComplete="name"
            autoFocus
            disabled={leaving}
          />
        </div>
        <div className="flex justify-end border-t border-border/80 pt-4">
          <Button type="submit" disabled={!normalizedName || leaving}>
            {leaving ? <Loader2 className="animate-spin" /> : null}
            {leaving ? "正在进入对话" : "开始对话"}
            {!leaving ? <ArrowRight /> : null}
          </Button>
        </div>
      </form>
    </div>
  );
}
