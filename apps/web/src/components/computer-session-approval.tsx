"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Runtime = {
  runtimeId: string;
  computerId: string;
  incarnation: string;
  createOperationId: string;
  state: string;
  executionAvailable: boolean;
};

const states: Record<string, string> = {
  pending_approval: "该电脑等待创建确认",
  creating: "该电脑正在创建",
  unknown: "创建结果待核实",
};

// Chat-side counterpart of computer-runtime-controls. The full lifecycle lives on
// the settings page; here we only surface a session-scoped runtime that still
// needs an explicit approval, or a reconcile of an uncertain create. A creation is
// never retried implicitly: if the response is lost the user re-triggers it.
export function ComputerSessionApproval({ agentId, sessionId, spaceId }: { agentId: string; sessionId: string; spaceId: string }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);

  const path = (r: Runtime) => `/api/spaces/${encodeURIComponent(spaceId)}/computers/${encodeURIComponent(r.computerId)}/runtimes/${encodeURIComponent(r.runtimeId)}`;
  async function read(r: Runtime) {
    setRuntime(await api<Runtime>(`${path(r)}?incarnation=${encodeURIComponent(r.incarnation)}`, { cacheTtlMs: false }));
  }

  useEffect(() => {
    const current = ++generation.current;
    lock.current = false;
    setRuntime(null);
    void (async () => {
      try {
        const selection = await api<{ computerId?: string | null }>(`/api/agents/${encodeURIComponent(agentId)}/cloud/sessions/${encodeURIComponent(sessionId)}/computer`, { cacheTtlMs: false });
        const computerId = selection.computerId ?? "";
        if (current !== generation.current || !computerId || computerId.startsWith("legacy:")) return;
        // Reservation records intent only and is idempotent: retrying recovers the
        // same persisted operation, so it is safe to call on every chat mount.
        const reserved = await api<Runtime>(`/api/spaces/${encodeURIComponent(spaceId)}/computers/${encodeURIComponent(computerId)}/runtimes?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
        if (current === generation.current) setRuntime(reserved);
      } catch (e) {
        if (current === generation.current) toast.error(e instanceof Error ? e.message : "读取执行电脑创建状态失败");
      }
    })();
    return () => { generation.current++; };
  }, [agentId, sessionId, spaceId]);

  async function act(action: "approve" | "reconcile") {
    if (!runtime || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await api<Runtime>(`${path(runtime)}/${action}`, {
        method: "POST",
        json: { incarnation: runtime.incarnation, createOperationId: runtime.createOperationId, confirm: action === "approve" },
      });
      await read(runtime);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : action === "approve" ? "确认创建失败" : "核实创建结果失败");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!runtime || !(runtime.state in states)) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span>{states[runtime.state]}</span>
    {runtime.state === "pending_approval"
      ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void act("approve")}>确认创建</Button>
      : <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void act("reconcile")}>核实创建结果</Button>}
  </div>;
}
