"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 高度自适应的展开容器。
 *
 * 用 grid-template-rows 0fr→1fr 做高度补间：不需要测量真实高度，内容多高都精确，
 * 展开/收起还能被随时打断（连点不会卡在中间高度）。内容常驻 DOM，收起时置 inert
 * 以免键盘焦点掉进看不见的区域。
 */
export function Disclosure({
  open,
  className,
  innerClassName,
  children,
}: {
  open: boolean;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("disclosure", className)}
      data-open={open ? "" : undefined}
      inert={!open}
    >
      <div className={cn("disclosure-inner", innerClassName)}>{children}</div>
    </div>
  );
}
