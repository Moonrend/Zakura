"use client";

import { useTheme } from "next-themes";
import MarkdownRender, {
  MarkdownCodeBlockNode,
  setCustomComponents,
  type NodeComponentProps,
} from "markstream-react";
import { cn } from "@/lib/utils";
import { ensureMarkstream } from "./markstream-setup";

ensureMarkstream();

type CodeBlockAst = {
  type: "code_block";
  language: string;
  code: string;
  raw: string;
  diff?: boolean;
  originalCode?: string;
  updatedCode?: string;
};

/** Shiki 高亮 + 自带复制按钮；主题用灰调，不用纯黑 */
function ChatCodeBlock({
  node,
  isDark,
  ctx,
}: NodeComponentProps<CodeBlockAst>) {
  return (
    <MarkdownCodeBlockNode
      node={node}
      isDark={isDark}
      stream={ctx?.codeBlockStream !== false}
      lightTheme="github-light"
      darkTheme="github-dark-dimmed"
      showFontSizeButtons={false}
      showCollapseButton={false}
      showTooltips={false}
      {...(ctx?.codeBlockProps as object | undefined)}
    />
  );
}

let codeRegistered = false;
function ensureCodeBlock() {
  if (codeRegistered) return;
  codeRegistered = true;
  setCustomComponents("chat-md", { code_block: ChatCodeBlock });
}
ensureCodeBlock();

export type ChatMarkdownVariant = "chat" | "compact" | "muted";

const VARIANT_CLASS: Record<ChatMarkdownVariant, string> = {
  chat: "chat-md chat-md--chat",
  compact: "chat-md chat-md--compact",
  muted: "chat-md chat-md--muted",
};

/**
 * 聊天区 Markdown（markstream）：
 * - 公式：内置 KaTeX 节点
 * - 代码：Shiki 渲染 + 复制按钮（灰底，非纯黑）
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
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  if (!content) return null;

  return (
    <div className={cn(VARIANT_CLASS[variant], className)}>
      <MarkdownRender
        content={content}
        final={final}
        fade={fade}
        customId="chat-md"
        isDark={isDark}
        codeBlockStream
        themes={["github-light", "github-dark-dimmed"]}
        codeBlockProps={{
          showCopyButton: true,
          showHeader: true,
          showFontSizeButtons: false,
          showCollapseButton: false,
          showTooltips: false,
        }}
        deferNodesUntilVisible={false}
        viewportPriority={false}
        langs={[
          "typescript",
          "javascript",
          "tsx",
          "jsx",
          "json",
          "bash",
          "shell",
          "python",
          "go",
          "rust",
          "sql",
          "yaml",
          "toml",
          "html",
          "css",
          "markdown",
          "diff",
        ]}
      />
    </div>
  );
}
