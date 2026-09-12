"use client";

import { useLayoutEffect, useState } from "react";
import {
  pointerHiddenForView,
  type PresenceTurnPage,
} from "@zakura/shared";
import type { RemoteAwareness } from "@/lib/sync/session-doc";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** 远程鼠标：按 turn seq 定位，未加载的 turn 不画幽灵指针。 */
export function PresencePointers({
  remotes,
  followUserId,
  container,
  turns,
}: {
  remotes: RemoteAwareness[];
  followUserId: string | null;
  container: HTMLElement | null;
  turns: PresenceTurnPage[];
}) {
  const [, bump] = useState(0);
  useLayoutEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(container);
    const onScroll = () => bump((n) => n + 1);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      container.removeEventListener("scroll", onScroll);
    };
  }, [container]);

  if (!container) return null;
  const host = container.getBoundingClientRect();

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {remotes.map((r) => {
        const ptr = r.pointer;
        if (!ptr) return null;
        if (pointerHiddenForView(r, turns)) return null;
        let left: number;
        let top: number;
        if (ptr.seq > 0) {
          const turn = container.querySelector(`[data-turn-seq="${ptr.seq}"]`);
          if (!(turn instanceof HTMLElement)) return null;
          const box = turn.getBoundingClientRect();
          left = box.left - host.left + clamp01(ptr.x) * box.width;
          top = box.top - host.top + clamp01(ptr.y) * box.height;
        } else {
          left = clamp01(ptr.x) * host.width;
          top = clamp01(ptr.y) * host.height;
        }
        const following = followUserId === r.user.id;
        return (
          <div
            key={r.clientId}
            className="absolute -translate-x-1 -translate-y-1"
            style={{ left, top }}
          >
            <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
              <path
                d="M1 1.2 1 14.5 5.2 11.1 8.8 17.2 10.6 16.2 7.1 10.2 12.8 9.9Z"
                fill={r.user.color}
                stroke="white"
                strokeWidth="0.8"
              />
            </svg>
            <span
              className={cn(
                "ml-1.5 text-[10px] font-medium",
                following && "underline underline-offset-2",
              )}
              style={{ color: r.user.color }}
            >
              {r.user.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Composer 内远程 caret：同一字体镜像定位。 */
export function ComposerCarets({
  remotes,
  value,
}: {
  remotes: RemoteAwareness[];
  value: string;
}) {
  const withCaret = remotes.filter((r) => r.caret);
  if (withCaret.length === 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 z-10 px-4 pt-3.5 pb-1 text-base md:text-[15px]"
    >
      {withCaret.map((r) => {
        const caret = r.caret!;
        const len = value.length;
        const anchor = Math.max(0, Math.min(len, caret.anchor));
        const head = Math.max(0, Math.min(len, caret.head));
        const lo = Math.min(anchor, head);
        const hi = Math.max(anchor, head);
        const selected = lo !== hi;
        const caretEl = (
          <span
            className="inline-block h-[1.1em] w-0.5 translate-y-0.5 align-text-bottom"
            style={{ background: r.user.color }}
            title={r.user.name}
          />
        );
        return (
          <pre
            key={r.clientId}
            className="absolute inset-x-0 top-0 whitespace-pre-wrap break-words font-sans text-transparent"
          >
            {value.slice(0, lo)}
            {head === lo ? caretEl : null}
            {selected ? (
              <span style={{ background: r.user.color, opacity: 0.28 }}>{value.slice(lo, hi)}</span>
            ) : null}
            {head === hi && selected ? caretEl : null}
          </pre>
        );
      })}
    </div>
  );
}

export function FollowChip({
  name,
  userId,
  onStop,
}: {
  name: string;
  userId: string;
  onStop: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onStop}
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors duration-150 ease-fluid hover:text-foreground"
      title="取消跟随"
    >
      <UserAvatar userId={userId} name={name} size="sm" className="size-4" />
      跟随 {name}
    </button>
  );
}
