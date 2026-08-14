"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as WTermTerminal, useTerminal } from "@wterm/react";
import "@wterm/react/css";
import { Loader2, Maximize2, RotateCcw, Unplug } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WorkspaceTerminalRequest = { profileId?: string; profileName?: string };
type State = "idle" | "connecting" | "connected" | "error" | "closed";
type Ticket = { url: string; ticket: string };

function runtimeSocketUrl(url: string): string {
  const target = new URL(url, window.location.href);
  if (target.hostname === "127.0.0.1" || target.hostname === "localhost") {
    target.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    target.host = window.location.host;
  }
  return target.toString();
}

export function WorkspaceTerminalDialog({
  agentId,
  open,
  request,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  request?: WorkspaceTerminalRequest;
  onOpenChange: (open: boolean) => void;
}) {
  const { ref, write, focus } = useTerminal();
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const generationRef = useRef(0);
  const [state, setState] = useState<State>("idle");
  const [detail, setDetail] = useState("等待建立动态会话");

  const disconnect = useCallback((next: State = "closed") => {
    generationRef.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client closed");
    setState(next);
    setDetail(next === "closed" ? "会话已关闭" : "连接已断开");
  }, []);

  const connect = useCallback(async () => {
    disconnect("idle");
    const generation = generationRef.current;
    setState("connecting");
    setDetail("正在向平台申请一次性连接凭据…");
    try {
      const ticket = await api<Ticket>(`/api/agents/${agentId}/terminal-ticket`, { method: "POST" });
      if (generation !== generationRef.current) return;
      const socket = new WebSocket(runtimeSocketUrl(ticket.url));
      socketRef.current = socket;
      socket.onopen = () => {
        setDetail("凭据已验证，正在启动容器 PTY…");
        socket.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
      };
      socket.onmessage = (event) => {
        let message: { type?: string; data?: string; message?: string; command?: string; code?: number | null };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          write(String(event.data));
          return;
        }
        if (message.type === "ready") {
          setState("connected");
          setDetail(message.command || "bash -l");
          socket.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
          focus();
        } else if (message.type === "output" && message.data) {
          write(message.data);
        } else if (message.type === "reset") {
          // The server only asks for a reset if its bounded raw PTY backlog
          // rolled over while this browser was disconnected or stalled.
          write("\x1bc");
        } else if (message.type === "error") {
          setState("error");
          setDetail(message.message || "终端连接失败");
        } else if (message.type === "exit") {
          setState("closed");
          setDetail(`PTY 已退出${message.code == null ? "" : ` · code ${message.code}`}`);
        }
      };
      socket.onerror = () => {
        setState("error");
        setDetail("WebSocket 无法连接到 reCloud Server");
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setState((current) => (current === "error" ? current : "closed"));
        if (event.reason) setDetail(event.reason);
      };
    } catch (error) {
      setState("error");
      setDetail(error instanceof Error ? error.message : String(error));
    }
  }, [agentId, disconnect, focus, write]);

  useEffect(() => {
    if (open) void connect();
    else disconnect("idle");
    return () => disconnect("idle");
  }, [connect, disconnect, open]);

  const handleData = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle className="text-sm">平台代理终端{request?.profileName ? ` · ${request.profileName}` : ""}</DialogTitle>
            <DialogDescription className="truncate text-xs">
              {state === "connected" ? "已连接" : state === "connecting" ? "连接中" : state === "error" ? "连接失败" : "已断开"} · {detail}
            </DialogDescription>
          </div>
          {state === "connecting" ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => focus()}>
            <Maximize2 /><span className="sr-only">聚焦终端</span>
          </Button>
          {state === "connected" ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => disconnect()}>
              <Unplug />断开
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => void connect()}>
              <RotateCcw />重连
            </Button>
          )}
        </DialogHeader>
        <div className="min-h-[420px] bg-[#090b0d] p-3 sm:min-h-[620px]">
          <WTermTerminal
            ref={ref}
            wasmUrl="/wterm.wasm"
            autoResize
            cursorBlink
            onData={handleData}
            onResize={(cols, rows) => {
              sizeRef.current = { cols, rows };
              const socket = socketRef.current;
              if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
            }}
            className="h-[min(72vh,680px)] w-full rounded-sm bg-[#090b0d]"
            aria-label="平台代理实时终端"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
