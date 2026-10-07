"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Runtime = {
  runtimeId: string;
  computerId: string;
  incarnation: string;
  createOperationId: string;
  state: string;
  executionAvailable: boolean;
};
const states: Record<string, string> = {
  pending_approval: "等待创建确认", creating: "创建中", ready: "环境已创建",
  unknown: "创建结果待核实", disconnected: "已断开", stopping: "停止中",
  expired: "已过期", destroyed: "已销毁", failed: "失败",
};

// Mounted with the full space/computer key. Never transfer an operation or
// incarnation to another card; mutations are only triggered by explicit clicks.
export function ComputerRuntimeControls({ base, name }: { base: string; name: string }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const root = `${base}/runtimes`;
  const path = (r: Runtime) => `${root}/${encodeURIComponent(r.runtimeId)}`;
  async function read(r: Runtime) {
    const result = await api<Runtime>(`${path(r)}?incarnation=${encodeURIComponent(r.incarnation)}`, { cacheTtlMs: false });
    setRuntime(result);
    setUncertain(false);
    return result;
  }
  async function act(action: "reserve" | "refresh" | "approve" | "reconcile") {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "reserve") {
        // Intent only: retrying recovers the same persisted operation.
        setRuntime(await api<Runtime>(root, { method: "POST" }));
      } else if (runtime) {
        if (action === "refresh") await read(runtime);
        else {
          setConfirm(false);
          // If the response is lost, disable approval until a read succeeds.
          setUncertain(true);
          setRuntime(await api<Runtime>(`${path(runtime)}/${action}`, {
            method: "POST", json: { incarnation: runtime.incarnation, createOperationId: runtime.createOperationId, confirm: action === "approve" },
          }));
          setUncertain(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "运行环境操作失败");
      if (runtime && (action === "approve" || action === "reconcile")) {
        // Read-only recovery; never silently resend a creation request.
        try { await read(runtime); } catch { setUncertain(true); }
      }
    } finally { lock.current = false; setBusy(false); }
  }
  return <div className="mt-4 space-y-3 border-t pt-3">
    {runtime && <p role="status" className="text-xs text-muted-foreground">{uncertain ? "状态未确认，请刷新" : states[runtime.state] ?? runtime.state}{!runtime.executionAvailable && " · 执行通道尚未接通"}</p>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {!runtime ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reserve")}>{busy ? "读取中…" : "准备 / 查看运行环境"}</Button> : <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("refresh")}>刷新状态</Button>
        {runtime.state === "pending_approval" && !uncertain && <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>创建运行环境</Button>}
        {["unknown", "creating"].includes(runtime.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reconcile")}>核实创建结果</Button>}
      </>}
    </div>
    {runtime && ["unknown", "creating"].includes(runtime.state) && <p className="text-xs text-muted-foreground">核实只查找本次创建的环境，不会创建第二个容器。</p>}
    <Dialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <DialogContent><DialogHeader><DialogTitle>创建 {name} 的运行环境？</DialogTitle><DialogDescription>将在所选服务器上创建独立容器和数据卷，占用服务器资源。不会替换已有电脑或共用其文件。当前执行通道尚未接通，创建后仍不能用于对话执行。</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button disabled={busy || uncertain || runtime?.state !== "pending_approval"} onClick={() => void act("approve")}>确认创建</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
