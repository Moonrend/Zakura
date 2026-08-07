"use client";

import MarkdownRender from "markstream-react";
import { cn } from "@/lib/utils";
import { ensureMarkstream } from "./markstream-setup";

ensureMarkstream();

export type ChatMarkdownVariant = "chat" | "compact" | "muted";

const VARIANT_CLASS: Record<ChatMarkdownVariant, string> = {
  chat: "chat-md chat-md--chat",
  compact: "chat-md chat-md--compact",
  muted: "chat-md chat-md--muted",
};

/**
 * 聊天区 Markdown：完整走 markstream。
 * - 公式：内置 MathBlock / MathInline + katex peer
 * - 代码：renderCodeBlocksAsPre → 传统 <pre><code>，样式由 .chat-md 控制成灰底
 */
export function ChatMarkdown({
  content,
  final = true,
  fade = false,
  variant = "chat",
  className,
}: {
  content: string;
  final?: boolean;
  fade?: boolean;
  variant?: ChatMarkdownVariant;
  className?: string;
}) {
  if (!content) return null;

  return (
    <div className={cn(VARIANT_CLASS[variant], className)}>
      <MarkdownRender
        content={content}
        final={final}
        fade={fade}
        renderCodeBlocksAsPre
        // 聊天要立刻出公式/表格，不要等进视口
        deferNodesUntilVisible={false}
        viewportPriority={false}
      />
    </div>
  );
}
