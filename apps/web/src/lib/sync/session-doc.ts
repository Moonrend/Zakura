"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import * as Y from "yjs";
import { textDiff, shiftIndex } from "@zakura/shared";
import { acquireSocket } from "@/lib/socket";
import { b64ToU8, u8ToB64 } from "./bytes";

const LOCAL = Symbol("y-local");

/**
 * 会话草稿协同：Yjs Y.Text 经 Socket.IO 差量同步，多端（含同一用户多标签）
 * 共享同一份草稿。查看类状态（鼠标、展开、光标等）不再同步，见 useTenantPresence。
 */
export function useSessionDoc(opts: {
  agentId: string | null;
  sessionId: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string) => void;
}): {
  bindValueChange: (value: string) => void;
  setPaused: (paused: boolean) => void;
  ready: boolean;
} {
  const [ready, setReady] = useState(false);
  const ytextRef = useRef<Y.Text | null>(null);
  const onValueChangeRef = useRef(opts.onValueChange);
  onValueChangeRef.current = opts.onValueChange;
  const textareaRef = opts.textareaRef;
  const pausedRef = useRef(false);
  const composingRef = useRef(false);
  const pendingRemoteRef = useRef<string | null>(null);

  const applyRemoteValue = useCallback(
    (next: string, keepSelection: boolean) => {
      if (pausedRef.current || composingRef.current) {
        pendingRemoteRef.current = next;
        return;
      }
      pendingRemoteRef.current = null;
      const ta = textareaRef.current;
      const prev = ta?.value ?? "";
      if (prev === next) return;
      let nextStart = 0;
      let nextEnd = 0;
      const restore = keepSelection && Boolean(ta) && document.activeElement === ta;
      if (restore && ta) {
        const { start, deleted, inserted } = textDiff(prev, next);
        nextStart = shiftIndex(ta.selectionStart, start, deleted, inserted.length);
        nextEnd = shiftIndex(ta.selectionEnd, start, deleted, inserted.length);
      }
      onValueChangeRef.current(next);
      if (!restore || !ta) return;
      const start = nextStart;
      const end = nextEnd;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el || document.activeElement !== el) return;
        el.setSelectionRange(start, end);
      });
    },
    [textareaRef],
  );

  useEffect(() => {
    const agentId = opts.agentId;
    const sessionId = opts.sessionId;
    if (!agentId || !sessionId) {
      ytextRef.current = null;
      setReady(false);
      return;
    }

    const { socket, release } = acquireSocket();
    const doc = new Y.Doc();
    const ytext = doc.getText("draft");
    ytextRef.current = ytext;
    let alive = true;

    const onYText = (_event: Y.YTextEvent, tr: Y.Transaction) => {
      if (!alive || tr.origin === LOCAL) return;
      applyRemoteValue(ytext.toString(), true);
    };
    ytext.observe(onYText);

    const onDoc = (update: Uint8Array, txOrigin: unknown) => {
      if (txOrigin === "remote") return;
      socket.emit("sync:update", { sessionId, update: u8ToB64(update) });
    };
    doc.on("update", onDoc);

    const onSyncUpdate = (payload: { sessionId?: string; update?: string; from?: string }) => {
      if (payload.sessionId !== sessionId || payload.from === socket.id) return;
      if (typeof payload.update !== "string") return;
      Y.applyUpdate(doc, b64ToU8(payload.update), "remote");
    };
    socket.on("sync:update", onSyncUpdate);

    const subscribe = () => {
      if (!alive) return;
      socket.emit(
        "sync:sub",
        { agentId, sessionId, sv: u8ToB64(Y.encodeStateVector(doc)) },
        (res: { ok: true; update: string; sv?: string } | { ok: false; error: string }) => {
          if (!alive) return;
          if (!res?.ok) {
            setReady(false);
            return;
          }
          Y.applyUpdate(doc, b64ToU8(res.update), "remote");
          if (res.sv) {
            const diff = Y.encodeStateAsUpdate(doc, b64ToU8(res.sv));
            if (diff.byteLength > 2) {
              socket.emit("sync:update", { sessionId, update: u8ToB64(diff) });
            }
          }
          applyRemoteValue(ytext.toString(), false);
          setReady(true);
        },
      );
    };

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();

    const onCompStart = (e: Event) => {
      if (e.target !== textareaRef.current) return;
      composingRef.current = true;
    };
    const onCompEnd = (e: Event) => {
      if (e.target !== textareaRef.current) return;
      composingRef.current = false;
      // 组字期间积压的远程快照已经过期：随后 onChange 会把选词写进 ytext。
      pendingRemoteRef.current = null;
    };
    document.addEventListener("compositionstart", onCompStart, true);
    document.addEventListener("compositionend", onCompEnd, true);

    return () => {
      alive = false;
      document.removeEventListener("compositionstart", onCompStart, true);
      document.removeEventListener("compositionend", onCompEnd, true);
      socket.off("connect", subscribe);
      socket.off("sync:update", onSyncUpdate);
      socket.emit("sync:unsub", { sessionId });
      ytext.unobserve(onYText);
      doc.off("update", onDoc);
      doc.destroy();
      ytextRef.current = null;
      setReady(false);
      release();
    };
  }, [opts.agentId, opts.sessionId, applyRemoteValue, textareaRef]);

  const bindValueChange = useCallback(
    (next: string) => {
      onValueChangeRef.current(next);
      if (pausedRef.current) return;
      const ytext = ytextRef.current;
      if (!ytext) return;
      const prev = ytext.toString();
      if (prev === next) return;
      const { start, deleted, inserted } = textDiff(prev, next);
      ytext.doc!.transact(() => {
        if (deleted > 0) ytext.delete(start, deleted);
        if (inserted) ytext.insert(start, inserted);
      }, LOCAL);
    },
    [],
  );

  const setPaused = useCallback(
    (paused: boolean) => {
      pausedRef.current = paused;
      if (paused) return;
      pendingRemoteRef.current = null;
      const ytext = ytextRef.current;
      if (ytext) applyRemoteValue(ytext.toString(), false);
    },
    [applyRemoteValue],
  );

  return { bindValueChange, setPaused, ready };
}
