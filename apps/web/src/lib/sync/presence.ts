"use client";

import { useEffect, useRef, useState } from "react";
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_LOCATION_THROTTLE_MS,
  isPresenceUser,
  mergePresenceByUser,
  type PresenceLocation,
  type PresencePane,
} from "@zakura/shared";
import { acquireSocket } from "@/lib/socket";

export function useTenantPresence(opts: {
  userId: string | null;
  agentId: string | null;
  project: string | null;
  sessionId: string | null;
  pane: PresencePane;
  filePath?: string | null;
  fileDir?: boolean;
}): PresenceLocation[] {
  const [peers, setPeers] = useState<PresenceLocation[]>([]);
  const locRef = useRef(opts);
  locRef.current = opts;

  useEffect(() => {
    if (!isPresenceUser(opts.userId)) return;
    const { socket, release } = acquireSocket();

    const onState = (raw: unknown) => {
      if (!Array.isArray(raw)) return;
      setPeers(mergePresenceByUser(raw as PresenceLocation[]));
    };
    const onUpdate = (raw: unknown) => {
      const loc = raw as PresenceLocation;
      if (!loc?.userId) return;
      setPeers((prev) => mergePresenceByUser([...prev.filter((p) => p.userId !== loc.userId), loc]));
    };
    const onLeave = (raw: unknown) => {
      const userId = (raw as { userId?: string } | null)?.userId;
      if (!userId) return;
      setPeers((prev) => prev.filter((p) => p.userId !== userId));
    };

    socket.on("presence:state", onState);
    socket.on("presence:update", onUpdate);
    socket.on("presence:leave", onLeave);

    const emit = () => {
      const cur = locRef.current;
      socket.emit("presence:update", {
        agentId: cur.agentId,
        project: cur.project,
        sessionId: cur.sessionId,
        pane: cur.pane,
        filePath: cur.filePath ?? null,
        fileDir: Boolean(cur.fileDir),
        idle: document.visibilityState !== "visible",
      });
    };

    // 重连是新的服务端 socket，必须再报一次位置，否则要等 20s 心跳
    socket.on("connect", emit);
    if (socket.connected) emit();
    const beat = window.setInterval(emit, PRESENCE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", emit);

    return () => {
      window.clearInterval(beat);
      document.removeEventListener("visibilitychange", emit);
      socket.off("connect", emit);
      socket.off("presence:state", onState);
      socket.off("presence:update", onUpdate);
      socket.off("presence:leave", onLeave);
      release();
    };
  }, [opts.userId]);

  useEffect(() => {
    if (!isPresenceUser(opts.userId)) return;
    const timer = window.setTimeout(() => {
      const { socket, release } = acquireSocket();
      socket.emit("presence:update", {
        agentId: opts.agentId,
        project: opts.project,
        sessionId: opts.sessionId,
        pane: opts.pane,
        filePath: opts.filePath ?? null,
        fileDir: Boolean(opts.fileDir),
        idle: document.visibilityState !== "visible",
      });
      release();
    }, PRESENCE_LOCATION_THROTTLE_MS);
    return () => window.clearTimeout(timer);
  }, [opts.userId, opts.agentId, opts.project, opts.sessionId, opts.pane, opts.filePath, opts.fileDir]);

  return peers;
}
