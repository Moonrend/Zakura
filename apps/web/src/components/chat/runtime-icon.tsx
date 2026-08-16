import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Brain,
  CircleDot,
  Code2,
  Moon,
  Send,
  Sparkle,
  Terminal,
  Zap,
} from "lucide-react";
import { ZAKURA_RUNTIME_ID } from "@zakura/shared";

import { cn } from "@/lib/utils";

const LUCIDE_BY_ID: Record<string, LucideIcon> = {
  "claude-code": Brain,
  codex: Terminal,
  "gemini-cli": Sparkle,
  hermes: Send,
  grok: Zap,
  copilot: Bot,
  "kimi-code": Moon,
  pi: CircleDot,
  opencode: Code2,
};

export function RuntimeIcon({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  if (id === ZAKURA_RUNTIME_ID) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/icons/icon-192.png"
        alt=""
        className={cn("size-3.5 shrink-0 rounded-[3px]", className)}
      />
    );
  }
  const Icon = LUCIDE_BY_ID[id] ?? Bot;
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}
