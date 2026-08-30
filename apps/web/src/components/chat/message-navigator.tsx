"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ConversationTurn } from "@/lib/cloud-agent";

const MIN_TURNS = 3;
const PREVIEW_LEN = 55;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

export function MessageNavigator({
  turns,
  scrollEl,
}: {
  turns: ConversationTurn[];
  scrollEl: HTMLElement | null;
}) {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const rafRef = useRef<number>(0);
  // IntersectionObserver to track which turns are in view
  const observerRef = useRef<IntersectionObserver | null>(null);
  // map: messageId → whether it's intersecting
  const intersectingRef = useRef<Map<string, boolean>>(new Map());

  // Update active turn = topmost intersecting
  const pickActive = useCallback(() => {
    for (const turn of turns) {
      if (intersectingRef.current.get(turn.message.id)) {
        setActiveTurnId(turn.message.id);
        return;
      }
    }
    setActiveTurnId(null);
  }, [turns]);

  // Track scroll progress on the scroll container
  useEffect(() => {
    if (!scrollEl) return;
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        setScrollPct(scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 1);
      });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [scrollEl]);

  // Observe all turn elements
  useEffect(() => {
    if (!scrollEl || turns.length < MIN_TURNS) return;

    observerRef.current?.disconnect();
    intersectingRef.current.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.id.replace("turn-", "");
          intersectingRef.current.set(id, e.isIntersecting);
        }
        pickActive();
      },
      { root: scrollEl, threshold: 0, rootMargin: "-10% 0px -55% 0px" },
    );

    for (const turn of turns) {
      const el = document.getElementById(`turn-${turn.message.id}`);
      if (el) observer.observe(el);
    }
    observerRef.current = observer;
    return () => observer.disconnect();
  }, [scrollEl, turns, pickActive]);

  const jumpTo = useCallback((messageId: string) => {
    const el = document.getElementById(`turn-${messageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (turns.length < MIN_TURNS) return null;

  return (
    <div
      className={cn(
        "absolute top-1/2 right-0 z-20 -translate-y-1/2",
        "hidden lg:flex items-center",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 展开的消息列表面板 */}
      <div
        className={cn(
          "overflow-hidden transition-all",
          "duration-200 ease-out-soft",
          hovered ? "w-56 opacity-100" : "w-0 opacity-0 pointer-events-none",
        )}
      >
        <div className="mr-1 max-h-[min(70vh,480px)] overflow-y-auto rounded-lg border border-border/60 bg-background/96 shadow-[var(--shadow-soft)] backdrop-blur-sm">
          <div className="flex flex-col py-1">
            {turns.map((turn, i) => {
              const isActive = turn.message.id === activeTurnId;
              const preview = truncate(turn.message.content, PREVIEW_LEN);
              return (
                <button
                  key={turn.message.id}
                  type="button"
                  onClick={() => jumpTo(turn.message.id)}
                  className={cn(
                    "weight-hover group flex min-w-0 flex-col gap-0.5 px-3 py-2 text-left",
                    "transition-colors duration-100",
                    isActive
                      ? "bg-muted/70 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground/85",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn(
                      "text-[10px] tabular-nums shrink-0 leading-none",
                      isActive ? "text-foreground/40" : "text-muted-foreground/35",
                    )}>
                      {i + 1}
                    </span>
                    {isActive && (
                      <span className="size-1 shrink-0 rounded-sm bg-foreground/50 animate-pop" />
                    )}
                  </div>
                  <span className="min-w-0 line-clamp-2 text-[12px] leading-[1.45]">
                    {preview}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Minimap 竖条触发区 */}
      <div
        className={cn(
          "relative flex h-28 w-4 shrink-0 cursor-default flex-col items-center select-none",
          "transition-opacity duration-150",
          hovered ? "opacity-100" : "opacity-30 hover:opacity-60",
        )}
        aria-hidden
      >
        {/* 轨道线 */}
        <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border/50" />

        {/* turn 标记点 */}
        {turns.map((turn, i) => {
          const pct = turns.length > 1 ? i / (turns.length - 1) : 0.5;
          const isActive = turn.message.id === activeTurnId;
          return (
            <button
              key={turn.message.id}
              type="button"
              aria-label={`第 ${i + 1} 条消息`}
              onClick={() => jumpTo(turn.message.id)}
              className={cn(
                "absolute left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer",
                "rounded-sm transition-all duration-150 ease-spring",
                isActive
                  ? "size-[5px] bg-foreground/75"
                  : "size-[3px] bg-foreground/28 hover:size-[4px] hover:bg-foreground/55",
              )}
              style={{ top: `${4 + pct * 88}%` }}
            />
          );
        })}

        {/* 滚动位置滑块 */}
        <div
          className="absolute left-1/2 h-5 w-[3px] -translate-x-1/2 rounded-full bg-foreground/25 transition-[top] duration-75"
          style={{ top: `${4 + scrollPct * 88}%` }}
        />
      </div>
    </div>
  );
}
