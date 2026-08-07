"use client";

/**
 * markstream 客户端启动（聊天流式用根入口 `markstream-react`）。
 *
 * 官方约定：装上 katex peer + 引入 CSS，内置 Math 节点会自动加载。
 * 这里再静态引用一次 katex，避免 bundler 把动态 import 摇掉。
 */
import "markstream-react/index.css";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import katex from "katex";

void katex.version;

let booted = false;

/** 幂等：在首个 ChatMarkdown 挂载前调用即可 */
export function ensureMarkstream() {
  if (booted) return;
  booted = true;
}
