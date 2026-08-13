"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 粘底滚动。
 *
 * 只有当用户本来就在底部附近时才跟随新内容；一旦用户往上翻阅就停止跟随，
 * 避免流式输出把人「拽」回底部。内容自身长高（流式 token、工具行插入、图片
 * 加载完成）由 ResizeObserver 捕捉，调用方不必在每次更新时手动同步。
 *
 * 用回调 ref 而非对象 ref：滚动容器往往在鉴权完成后才挂载，对象 ref 配 `[]`
 * 依赖会让监听器永远绑不上。
 */
export function useStickToBottom<
  TScroll extends HTMLElement,
  TContent extends HTMLElement,
>(threshold = 140) {
  const [scrollEl, setScrollEl] = useState<TScroll | null>(null);
  const [contentEl, setContentEl] = useState<TContent | null>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useCallback((node: TScroll | null) => {
    setScrollEl(node);
  }, []);
  const contentRef = useCallback((node: TContent | null) => {
    setContentEl(node);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (!scrollEl) return;
      stickRef.current = true;
      setAtBottom(true);
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior });
    },
    [scrollEl],
  );

  /** 显式跟随（仍受粘底状态约束：用户翻上去时不打扰） */
  const sync = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (!stickRef.current || !scrollEl) return;
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior });
    },
    [scrollEl],
  );

  useEffect(() => {
    if (!scrollEl) return;
    const onScroll = () => {
      const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      const near = distance <= threshold;
      stickRef.current = near;
      setAtBottom((prev) => (prev === near ? prev : near));
    };
    onScroll();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, threshold]);

  useEffect(() => {
    if (!scrollEl || !contentEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickRef.current) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [scrollEl, contentEl]);

  return { scrollRef, contentRef, scrollEl, atBottom, scrollToBottom, sync };
}
