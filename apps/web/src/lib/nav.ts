import type { MouseEvent } from "react";

/**
 * True when a click on an anchor should be left to the browser.
 *
 * Anything that navigates must be a real `<a href>` so right-click "copy link",
 * mobile long-press, cmd/ctrl-click and middle-click all work. When such a link
 * also has an `onClick` that loads content in place, that handler has to bow out
 * for these cases — otherwise "open in new tab" silently navigates the current
 * tab instead.
 */
export function shouldLetBrowserHandleClick(
  event: MouseEvent<HTMLElement>,
): boolean {
  return (
    event.defaultPrevented ||
    // 0 = primary. Middle-click arrives as an auxclick, but guard anyway.
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/** Deep link for a chat session, so session rows can be real anchors. */
export function chatSessionHref(agentId: string, sessionId: string): string {
  return `/chat?agent=${encodeURIComponent(agentId)}&session=${encodeURIComponent(sessionId)}`;
}

/** Deep link for a chat with an agent but no specific session. */
export function chatAgentHref(agentId: string): string {
  return `/chat?agent=${encodeURIComponent(agentId)}`;
}
