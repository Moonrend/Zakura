"use client";

import { ChatMarkdown } from "@/components/markdown/chat-markdown";
import { cn } from "@/lib/utils";

/** SKILL.md 预览：与聊天区同一套 Markdown 渲染，略紧凑 */
export function SkillMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <ChatMarkdown
      content={content}
      final
      fade={false}
      variant="compact"
      className={cn(className)}
    />
  );
}
