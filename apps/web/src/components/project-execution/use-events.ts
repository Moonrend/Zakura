"use client";
import { useEffect, useRef, useState } from "react";
import { getEvents, friendlyError, type Event } from "@/lib/project-execution";
export function useProjectEvents(
  projectId: string,
  runId: string,
  onChange: () => void,
) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    let alive = true,
      after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setEvents([]);
    setCursor(0);
    setError(null);
    const poll = async () => {
      try {
        const response = await getEvents(projectId, after, runId, abort.signal);
        if (!alive) return;
        if (!Number.isSafeInteger(response.cursor) || response.cursor < after)
          throw new Error("事件游标无效，请重新打开项目");
        after = response.cursor;
        setCursor(after);
        setError(null);
        if (response.items.length) {
          setEvents((previous) => {
            const merged = new Map(previous.map((e) => [e.id, e]));
            for (const e of response.items) merged.set(e.id, e);
            return [...merged.values()]
              .sort((a, b) => a.sequence - b.sequence)
              .slice(-300);
          });
          callback.current();
        }
        timer = setTimeout(
          poll,
          response.items.length === 200 ? 100 : document.hidden ? 10000 : 3000,
        );
      } catch (error) {
        if (!alive) return;
        setError(friendlyError(error));
        timer = setTimeout(poll, 6000);
      }
    };
    if (projectId) void poll();
    return () => {
      alive = false;
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, runId]);
  return { events, error, cursor };
}
