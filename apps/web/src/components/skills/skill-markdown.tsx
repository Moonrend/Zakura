"use client";

import MarkdownRender from "markstream-react";
// 技能页不在 /chat 布局下，样式表需要自己带
import "markstream-react/index.css";
import { cn } from "@/lib/utils";

/** SKILL.md 预览排版：与聊天区 Markdown 同一套尺度，稍紧凑 */
const SKILL_MD_CLASS =
  "max-w-full min-w-0 break-words text-[13.5px] leading-6 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:text-[12px] [&_code]:font-mono [&_code]:text-[0.88em] [&_p]:my-2 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13.5px] [&_h3]:font-medium [&_a]:underline [&_a]:underline-offset-2 [&_table]:my-2 [&_table]:text-[12.5px] [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:my-4 [&_hr]:border-border";

export function SkillMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn(SKILL_MD_CLASS, className)}>
      <MarkdownRender content={content} final fade={false} />
    </div>
  );
}
