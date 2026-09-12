"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  pointerHiddenForView,
  sameCaretChannel,
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

type CaretBox = { left: number; top: number; height: number };
type SelBox = CaretBox & { width: number };
type CaretMark = {
  key: number;
  color: string;
  name: string;
  caret: CaretBox;
  sel: SelBox[];
};

const MIRROR_PROPS = [
  "direction",
  "box-sizing",
  "overflow-x",
  "overflow-y",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size",
  "line-height",
  "font-family",
  "text-align",
  "text-transform",
  "text-indent",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "-moz-tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const;

function copyTextareaStyle(ta: HTMLTextAreaElement, dest: HTMLElement) {
  const cs = getComputedStyle(ta);
  for (const prop of MIRROR_PROPS) {
    const value = cs.getPropertyValue(prop);
    if (value) dest.style.setProperty(prop, value);
  }
  dest.style.position = "absolute";
  dest.style.visibility = "hidden";
  dest.style.pointerEvents = "none";
  dest.style.left = "0";
  dest.style.top = "0";
  dest.style.height = "auto";
  dest.style.width = `${ta.clientWidth}px`;
  dest.style.whiteSpace = "pre-wrap";
  dest.style.overflowWrap = cs.overflowWrap || "break-word";
  dest.style.overflow = "hidden";
  dest.style.font = cs.font;
}

function lineHeightPx(cs: CSSStyleDeclaration, fallbackHeight: number) {
  const raw = cs.lineHeight;
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n) && raw !== "normal") return n;
  const fs = Number.parseFloat(cs.fontSize);
  return Number.isFinite(fs) ? fs * 1.2 : fallbackHeight || 18;
}

/** 用隐藏镜像量 textarea 里某个下标的像素，避免 div/textarea 换行对不齐。 */
function measureIndex(ta: HTMLTextAreaElement, mirror: HTMLElement, index: number): CaretBox {
  copyTextareaStyle(ta, mirror);
  mirror.style.height = `${ta.clientHeight}px`;
  const cs = getComputedStyle(ta);
  const lh = lineHeightPx(cs, ta.clientHeight);
  const i = Math.max(0, Math.min(ta.value.length, index));
  mirror.textContent = ta.value.slice(0, i);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  mirror.scrollTop = ta.scrollTop;
  mirror.scrollLeft = ta.scrollLeft;
  const m = marker.getBoundingClientRect();
  const t = ta.getBoundingClientRect();
  return {
    left: m.left - t.left,
    top: m.top - t.top,
    height: m.height || lh,
  };
}

function measureRange(ta: HTMLTextAreaElement, mirror: HTMLElement, from: number, to: number): SelBox[] {
  if (from === to) return [];
  copyTextareaStyle(ta, mirror);
  mirror.style.height = `${ta.clientHeight}px`;
  mirror.textContent = ta.value || "\u200b";
  mirror.scrollTop = ta.scrollTop;
  mirror.scrollLeft = ta.scrollLeft;
  const node = mirror.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const len = node.textContent?.length ?? 0;
  const range = document.createRange();
  range.setStart(node, Math.max(0, Math.min(len, from)));
  range.setEnd(node, Math.max(0, Math.min(len, to)));
  const host = ta.getBoundingClientRect();
  return Array.from(range.getClientRects()).map((r) => ({
    left: r.left - host.left,
    top: r.top - host.top,
    width: r.width,
    height: r.height,
  }));
}

/** Composer 内远程 caret：按 textarea 计算样式量像素，而不是叠一层透明字。 */
export function ComposerCarets({
  remotes,
  value,
  textareaRef,
  channel,
}: {
  remotes: RemoteAwareness[];
  value: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  channel?: string;
}) {
  const [marks, setMarks] = useState<CaretMark[]>([]);
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const withCaret = remotes.filter((r) => r.caret && sameCaretChannel(channel, r.caret));
  const caretKey = withCaret
    .map((r) => `${r.clientId}:${r.caret!.anchor}:${r.caret!.head}`)
    .join("|");

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !caretKey) {
      setMarks([]);
      return;
    }
    const parent = ta.parentElement;
    if (!parent) return;
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    parent.appendChild(mirror);

    const paint = () => {
      const live = remotesRef.current.filter(
        (r) => r.caret && sameCaretChannel(channelRef.current, r.caret),
      );
      setMarks(
        live.map((r) => {
          const caret = r.caret!;
          const len = ta.value.length;
          const anchor = Math.max(0, Math.min(len, caret.anchor));
          const head = Math.max(0, Math.min(len, caret.head));
          return {
            key: r.clientId,
            color: r.user.color,
            name: r.user.name,
            caret: measureIndex(ta, mirror, head),
            sel: measureRange(ta, mirror, Math.min(anchor, head), Math.max(anchor, head)),
          };
        }),
      );
    };
    paint();
    ta.addEventListener("scroll", paint, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    ro?.observe(ta);
    return () => {
      ta.removeEventListener("scroll", paint);
      ro?.disconnect();
      mirror.remove();
    };
  }, [textareaRef, value, caretKey]);

  if (marks.length === 0) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {marks.map((m) => (
        <span key={m.key}>
          {m.sel.map((box, i) => (
            <span
              key={i}
              className="absolute"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                background: m.color,
                opacity: 0.28,
              }}
            />
          ))}
          <span
            className="absolute w-0.5 rounded-sm"
            title={m.name}
            style={{
              left: m.caret.left,
              top: m.caret.top,
              height: m.caret.height,
              background: m.color,
            }}
          />
        </span>
      ))}
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
