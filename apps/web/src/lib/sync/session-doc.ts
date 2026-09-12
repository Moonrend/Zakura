"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  identiconColor,
  POINTER_THROTTLE_MS,
  textDiff,
  type PresenceAwareness,
  type PresencePointer,
  type PresenceViewTurn,
} from "@zakura/shared";
import { acquireSocket } from "@/lib/socket";
import { b64ToU8, u8ToB64 } from "./bytes";

const LOCAL = Symbol("y-local");

function sameViewTurn(a: PresenceViewTurn, b: PresenceViewTurn | undefined) {
  return Boolean(
    b &&
      a.messageId === b.messageId &&
      a.parentKey === b.parentKey &&
      a.runId === b.runId,
  );
}

export type RemoteAwareness = PresenceAwareness & { clientId: number };

/** 会话级 last-write-wins 控件：模型、面板、打开的文件等。值为字符串。 */
export type SessionPrefs = Record<string, string>;

export function useSessionDoc(opts: {
  agentId: string | null;
  sessionId: string | null;
  userId: string | null;
  name: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string) => void;
  onPrefsChange?: (prefs: SessionPrefs) => void;
}): {
  bindValueChange: (value: string) => void;
  remotes: RemoteAwareness[];
  setPointer: (pointer: PresencePointer | null) => void;
  setView: (view: PresenceViewTurn[]) => void;
  ready: boolean;
  ui: Record<string, boolean>;
  setUiFlag: (key: string, value: boolean) => void;
  setPref: (key: string, value: string) => void;
  setPrefs: (patch: Record<string, string>) => void;
  setPrefIfAbsent: (patch: Record<string, string>) => void;
} {
  const [remotes, setRemotes] = useState<RemoteAwareness[]>([]);
  const [ready, setReady] = useState(false);
  const [ui, setUi] = useState<Record<string, boolean>>({});
  const ytextRef = useRef<Y.Text | null>(null);
  const yuiRef = useRef<Y.Map<boolean> | null>(null);
  const yprefsRef = useRef<Y.Map<string> | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const onValueChangeRef = useRef(opts.onValueChange);
  onValueChangeRef.current = opts.onValueChange;
  const onPrefsChangeRef = useRef(opts.onPrefsChange);
  onPrefsChangeRef.current = opts.onPrefsChange;
  const pointerRef = useRef<PresencePointer | null>(null);
  const viewRef = useRef<PresenceViewTurn[]>([]);
  const lastPointerAt = useRef(0);
  const textareaRef = opts.textareaRef;

  const pushAwareness = useCallback(() => {
    const awareness = awarenessRef.current;
    const ta = textareaRef.current;
    if (!awareness || !opts.userId) return;
    const hidden = document.visibilityState !== "visible";
    const caret =
      !hidden && ta && document.activeElement === ta
        ? { anchor: ta.selectionStart, head: ta.selectionEnd }
        : undefined;
    awareness.setLocalState({
      user: { id: opts.userId, name: opts.name, color: identiconColor(opts.userId) },
      caret,
      pointer: hidden ? null : pointerRef.current,
      view: viewRef.current,
    } satisfies PresenceAwareness);
  }, [opts.name, opts.userId, textareaRef]);

  useEffect(() => {
    const agentId = opts.agentId;
    const sessionId = opts.sessionId;
    const userId = opts.userId;
    if (!agentId || !sessionId || !userId) {
      ytextRef.current = null;
      yuiRef.current = null;
      yprefsRef.current = null;
      awarenessRef.current = null;
      viewRef.current = [];
      setReady(false);
      setRemotes([]);
      setUi({});
      return;
    }

    const { socket, release } = acquireSocket();
    const doc = new Y.Doc();
    const ytext = doc.getText("draft");
    const yui = doc.getMap<boolean>("ui");
    const yprefs = doc.getMap<string>("prefs");
    const awareness = new Awareness(doc);
    ytextRef.current = ytext;
    yuiRef.current = yui;
    yprefsRef.current = yprefs;
    awarenessRef.current = awareness;
    let alive = true;

    awareness.setLocalState({
      user: { id: userId, name: opts.name, color: identiconColor(userId) },
      pointer: null,
      view: viewRef.current,
    } satisfies PresenceAwareness);

    const onYText = (_event: Y.YTextEvent, tr: Y.Transaction) => {
      if (!alive || tr.origin === LOCAL) return;
      onValueChangeRef.current(ytext.toString());
    };
    ytext.observe(onYText);

    const snapUi = () => {
      const next: Record<string, boolean> = {};
      yui.forEach((v, k) => {
        if (typeof v === "boolean") next[k] = v;
      });
      setUi(next);
    };
    yui.observe(snapUi);
    snapUi();

    const snapPrefs = (_event?: Y.YMapEvent<string>, tr?: Y.Transaction) => {
      if (!alive || tr?.origin === LOCAL) return;
      const next: SessionPrefs = {};
      yprefs.forEach((v, k) => {
        if (typeof v === "string") next[k] = v;
      });
      onPrefsChangeRef.current?.(next);
    };
    yprefs.observe(snapPrefs);

    const refreshRemotes = () => {
      const mine = awareness.clientID;
      const next: RemoteAwareness[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === mine) return;
        const s = state as PresenceAwareness;
        if (!s?.user?.id) return;
        next.push({ ...s, clientId });
      });
      setRemotes(next);
    };
    awareness.on("change", refreshRemotes);

    const onDoc = (update: Uint8Array, txOrigin: unknown) => {
      if (txOrigin === "remote") return;
      socket.emit("sync:update", { sessionId, update: u8ToB64(update) });
    };
    doc.on("update", onDoc);

    const onAwareness = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "remote") return;
      const ids = [...changes.added, ...changes.updated, ...changes.removed];
      if (ids.length === 0) return;
      socket.emit("sync:awareness", {
        sessionId,
        update: u8ToB64(encodeAwarenessUpdate(awareness, ids)),
      });
    };
    awareness.on("update", onAwareness);

    const onSyncUpdate = (payload: { sessionId?: string; update?: string; from?: string }) => {
      if (payload.sessionId !== sessionId || payload.from === socket.id) return;
      if (typeof payload.update !== "string") return;
      Y.applyUpdate(doc, b64ToU8(payload.update), "remote");
    };
    const onSyncAwareness = (payload: { sessionId?: string; update?: string; from?: string }) => {
      if (payload.sessionId !== sessionId || payload.from === socket.id) return;
      if (typeof payload.update !== "string") return;
      applyAwarenessUpdate(awareness, b64ToU8(payload.update), "remote");
    };
    socket.on("sync:update", onSyncUpdate);
    socket.on("sync:awareness", onSyncAwareness);

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
          onValueChangeRef.current(ytext.toString());
          snapPrefs();
          setReady(true);
          pushAwareness();
        },
      );
    };

    socket.on("connect", subscribe);
    if (socket.connected) subscribe();

    const onSel = () => pushAwareness();
    const onVis = () => {
      if (document.visibilityState !== "visible") pointerRef.current = null;
      pushAwareness();
    };
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("visibilitychange", onVis);
      socket.off("connect", subscribe);
      socket.off("sync:update", onSyncUpdate);
      socket.off("sync:awareness", onSyncAwareness);
      socket.emit("sync:unsub", { sessionId });
      ytext.unobserve(onYText);
      yui.unobserve(snapUi);
      yprefs.unobserve(snapPrefs);
      doc.off("update", onDoc);
      awareness.off("update", onAwareness);
      awareness.off("change", refreshRemotes);
      awareness.destroy();
      doc.destroy();
      ytextRef.current = null;
      yuiRef.current = null;
      yprefsRef.current = null;
      awarenessRef.current = null;
      setReady(false);
      setRemotes([]);
      setUi({});
      release();
    };
  }, [opts.agentId, opts.sessionId, opts.userId, opts.name, pushAwareness]);

  const bindValueChange = useCallback(
    (next: string) => {
      onValueChangeRef.current(next);
      const ytext = ytextRef.current;
      if (!ytext) return;
      const prev = ytext.toString();
      if (prev === next) return;
      const { start, deleted, inserted } = textDiff(prev, next);
      ytext.doc!.transact(() => {
        if (deleted > 0) ytext.delete(start, deleted);
        if (inserted) ytext.insert(start, inserted);
      }, LOCAL);
      pushAwareness();
    },
    [pushAwareness],
  );

  const setPointer = useCallback(
    (pointer: PresencePointer | null) => {
      if (document.visibilityState !== "visible") {
        pointerRef.current = null;
        return;
      }
      pointerRef.current = pointer;
      const now = Date.now();
      if (pointer && now - lastPointerAt.current < POINTER_THROTTLE_MS) return;
      lastPointerAt.current = now;
      pushAwareness();
    },
    [pushAwareness],
  );

  const setView = useCallback(
    (view: PresenceViewTurn[]) => {
      const prev = viewRef.current;
      if (
        prev.length === view.length &&
        prev.every((p, i) => sameViewTurn(p, view[i]))
      ) {
        return;
      }
      viewRef.current = view;
      pushAwareness();
    },
    [pushAwareness],
  );

  const setUiFlag = useCallback((key: string, value: boolean) => {
    yuiRef.current?.set(key, value);
  }, []);

  const setPrefs = useCallback((patch: Record<string, string>) => {
    const map = yprefsRef.current;
    if (!map) return;
    map.doc!.transact(() => {
      for (const [key, value] of Object.entries(patch)) {
        if ((map.get(key) ?? "") === value) continue;
        if (value === "") map.delete(key);
        else map.set(key, value);
      }
    }, LOCAL);
  }, []);

  const setPref = useCallback(
    (key: string, value: string) => {
      setPrefs({ [key]: value });
    },
    [setPrefs],
  );

  const setPrefIfAbsent = useCallback((patch: Record<string, string>) => {
    const map = yprefsRef.current;
    if (!map) return;
    map.doc!.transact(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!value || map.has(key)) continue;
        map.set(key, value);
      }
    }, LOCAL);
  }, []);

  return { bindValueChange, remotes, setPointer, setView, ready, ui, setUiFlag, setPref, setPrefs, setPrefIfAbsent };
}
