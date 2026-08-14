"use client";

import { useEffect, useRef, useState } from "react";
import { Expand, Loader2, MonitorOff, RefreshCw, Unplug } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Ticket = { url: string; ticket: string };

function runtimeSocketUrl(url: string): string {
  const target = new URL(url, window.location.href);
  if (target.hostname === "127.0.0.1" || target.hostname === "localhost") {
    target.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    target.host = window.location.host;
  }
  return target.toString();
}

export function WorkspaceDesktop({ agentId, active }: { agentId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void; scaleViewport: boolean; resizeSession: boolean } | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("等待连接");

  useEffect(() => {
    if (!active || !hostRef.current) return;
    let disposed = false;
    setState("connecting");
    void Promise.all([
      import("@novnc/novnc"),
      api<Ticket>(`/api/agents/${agentId}/desktop-ticket`, { method: "POST" }),
    ]).then(([{ default: RFB }, ticket]) => {
      if (disposed || !hostRef.current) return;
      setMessage("正在验证 VNC 握手…");
      const rfb = new RFB(hostRef.current, runtimeSocketUrl(ticket.url));
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.addEventListener("connect", () => { setState("connected"); setMessage("动态平台代理 · 已加密连接"); });
      rfb.addEventListener("disconnect", (event: Event & { detail?: { clean?: boolean } }) => {
        setState(event.detail?.clean ? "idle" : "error");
        setMessage(event.detail?.clean ? "桌面会话已断开" : "桌面代理意外断开");
      });
      rfb.addEventListener("securityfailure", () => { setState("error"); setMessage("VNC 安全协商失败"); });
      rfbRef.current = rfb;
    }).catch((error) => { setState("error"); setMessage(error instanceof Error ? error.message : "桌面连接失败"); });
    return () => {
      disposed = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [active, agentId, attempt]);

  return <div className="overflow-hidden rounded-md border">
    <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{message}</span>
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => hostRef.current?.requestFullscreen()}>
        <Expand /><span className="sr-only">全屏</span>
      </Button>
      {state === "connected" ? <Button type="button" variant="ghost" size="icon-sm" onClick={() => rfbRef.current?.disconnect()}>
        <Unplug /><span className="sr-only">断开</span>
      </Button> : <Button type="button" variant="ghost" size="icon-sm" onClick={() => setAttempt((value) => value + 1)}>
        <RefreshCw /><span className="sr-only">重连</span>
      </Button>}
    </div>
    <div className="relative min-h-[360px] bg-black">
      <div ref={hostRef} className="h-[min(70vh,720px)] w-full" />
      {state !== "connected" ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/95 text-xs text-zinc-400">
        {state === "connecting" ? <Loader2 className="size-5 animate-spin" /> : <MonitorOff className="size-5" />}
        <span>{message}</span>
        {state === "error" ? <Button size="sm" variant="outline" className="mt-1 border-zinc-700 bg-zinc-900 text-zinc-200" onClick={() => setAttempt((value) => value + 1)}><RefreshCw />重新连接</Button> : null}
      </div> : null}
    </div>
  </div>;
}
