"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTheme } from "next-themes";
import MarkdownRender, {
  MarkdownCodeBlockNode,
  setCustomComponents,
  type NodeComponentProps,
} from "markstream-react";
import { Button } from "@/components/ui/button";
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

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="absolute top-1.5 right-1.5 z-10 text-muted-foreground hover:text-foreground"
      aria-label={copied ? "已复制" : "复制"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/** Shiki 高亮；无顶栏/语言标签，角上一个复制按钮 */
function ChatCodeBlock({
  node,
  isDark,
  ctx,
}: NodeComponentProps<CodeBlockAst>) {
  return (
    <div className="chat-md-code relative my-[0.6em] w-full">
      <MarkdownCodeBlockNode
        node={node}
        isDark={isDark}
        stream={ctx?.codeBlockStream !== false}
        lightTheme="github-light"
        darkTheme="github-dark-dimmed"
        showFontSizeButtons={false}
        showCollapseButton={false}
        showPreviewButton={false}
        showExpandButton={false}
        showTooltips={false}
        enableFontSizeControl={false}
        isShowPreview={false}
        {...(ctx?.codeBlockProps as object | undefined)}
        showHeader={false}
        showCopyButton={false}
      />
      <CodeCopyButton text={node.code} />
    </div>
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
 * - 代码：Shiki 渲染，无顶栏，角上复制
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
        // 生成中用稳定的 pre，避免代码高亮层重复挂载；完成后再启用高亮。
        renderCodeBlocksAsPre={!final}
        codeBlockStream={final}
        themes={["github-light", "github-dark-dimmed"]}
        codeBlockProps={{
          showCopyButton: false,
          showHeader: false,
          showFontSizeButtons: false,
          showCollapseButton: false,
          showPreviewButton: false,
          showExpandButton: false,
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
