"use client";

/**
 * markstream 客户端启动（聊天流式用根入口 `markstream-react`）。
 * 静态引用 peer，避免 bundler 把动态 import 摇掉 / stub 掉。
 */
import "markstream-react/index.css";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import katex from "katex";
import "stream-markdown";

void katex.version;

let booted = false;

/** 幂等：在首个 ChatMarkdown 挂载前调用即可 */
export function ensureMarkstream() {
  if (booted) return;
  booted = true;
}
