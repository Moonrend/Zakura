"use client";

import { useEffect, useRef, useState } from "react";
import { Expand, Loader2, MonitorOff, RefreshCw, Unplug } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { workspaceSocketUrl } from "@/lib/workspace-socket-url";

type Ticket = { url: string; ticket: string };

export function WorkspaceDesktop({ agentId, active }: { agentId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void; scaleViewport: boolean; resizeSession: boolean } | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("等待连接");
  const retries = useRef(0);
  const manualDisconnect = useRef(false);
  useEffect(() => { retries.current = 0; }, [agentId, active]);

  const reconnect = () => {
    retries.current = 0;
    manualDisconnect.current = false;
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    if (!active || !hostRef.current) {
      setState("idle");
      setMessage("工作区未运行");
      return;
    }
    let disposed = false;
    let retryScheduled = false;
    let rfb: NonNullable<typeof rfbRef.current> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    manualDisconnect.current = false;
    setState("connecting");
    setMessage("正在准备桌面…");
    const failed = (reason: string) => {
      if (disposed || retryScheduled || manualDisconnect.current) return;
      retryScheduled = true;
      clearTimeout(connectTimer);
      controller.abort();
      rfb?.disconnect();
      setState("error");
      if (retries.current < 3) {
        const count = ++retries.current;
        const delay = 1000 * 2 ** (count - 1);
        setMessage(`${reason}；${delay / 1000} 秒后重试（${count}/3）`);
        retryTimer = setTimeout(() => setAttempt((value) => value + 1), delay);
      } else setMessage(`${reason}；请查看工作区启动日志后重新连接。`);
    };
    let connectTimer = setTimeout(() => failed("桌面准备超时"), 50_000);
    void Promise.all([
      import("@novnc/novnc"),
      api<Ticket>(`/api/agents/${agentId}/desktop-ticket`, { method: "POST", signal: controller.signal }),
    ]).then(([{ default: RFB }, ticket]) => {
      if (disposed || retryScheduled || !hostRef.current) return;
      clearTimeout(connectTimer);
      setMessage("正在连接桌面…");
      const connection = new RFB(hostRef.current, workspaceSocketUrl(ticket.url, window.location.href));
      rfb = connection;
      connection.scaleViewport = true;
      // Scale the viewer only: changing Xvfb size invalidates computer_* coordinates.
      connection.resizeSession = false;
      connectTimer = setTimeout(() => failed("桌面连接超时"), 15_000);
      connection.addEventListener("connect", () => {
        if (disposed || retryScheduled) return;
        clearTimeout(connectTimer);
        retries.current = 0;
        setState("connected");
        setMessage("桌面已连接");
      });
      connection.addEventListener("disconnect", () => {
        if (disposed) return;
        clearTimeout(connectTimer);
        if (manualDisconnect.current) { setState("idle"); setMessage("桌面会话已断开"); }
        else failed("桌面连接已断开");
      });
      connection.addEventListener("securityfailure", () => failed("桌面安全协商失败"));
      rfbRef.current = connection;
    }).catch((error) => failed(error instanceof Error ? error.message : "桌面连接失败"));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(connectTimer);
      clearTimeout(retryTimer);
      rfb?.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [active, agentId, attempt]);

  return <div className="overflow-hidden rounded-md border">
    <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{message}</span>
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => { void hostRef.current?.requestFullscreen().catch(() => setMessage("无法进入全屏")); }}>
        <Expand /><span className="sr-only">全屏</span>
      </Button>
      {state === "connected" ? <Button type="button" variant="ghost" size="icon-sm" onClick={() => { manualDisconnect.current = true; rfbRef.current?.disconnect(); }}>
        <Unplug /><span className="sr-only">断开</span>
      </Button> : <Button type="button" variant="ghost" size="icon-sm" disabled={!active} onClick={reconnect}>
        <RefreshCw /><span className="sr-only">重连</span>
      </Button>}
    </div>
    <div className="relative min-h-[360px] bg-black">
      <div ref={hostRef} className="h-[min(70vh,720px)] w-full" />
      {state !== "connected" ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/95 text-xs text-zinc-400">
        {state === "connecting" ? <Loader2 className="size-5 animate-spin" /> : <MonitorOff className="size-5" />}
        <span className="max-w-xl whitespace-pre-wrap px-4 text-center">{message}</span>
        {state === "error" ? <Button size="sm" variant="outline" className="mt-1 border-zinc-700 bg-zinc-900 text-zinc-200" onClick={reconnect}><RefreshCw />重新连接</Button> : null}
      </div> : null}
    </div>
  </div>;
}
