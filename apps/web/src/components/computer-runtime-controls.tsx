"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const WorkspaceTerminalDialog = dynamic(
  () => import("@/components/workspace-terminal-dialog").then((m) => m.WorkspaceTerminalDialog),
  { ssr: false },
);

// Providers whose transport actually attaches an interactive shell, mirroring
// the backend capability grants.
const TERMINAL_PROVIDERS = new Set(["server", "temporary", "ssh", "railway"]);

type Runtime = {
  runtimeId: string;
  computerId: string;
  incarnation: string;
  createOperationId: string;
  state: string;
  executionAvailable: boolean;
  manifest?: { id?: string; preview?: string; claim?: string; deadline?: string };
};
const states: Record<string, string> = {
  pending_approval: "等待创建确认", creating: "创建中", ready: "环境已创建",
  unknown: "创建结果待核实", disconnected: "已断开", stopping: "停止中",
  expired: "已过期", destroyed: "已销毁", failed: "失败",
};

// Remaining lease from the provider's deadline string. A missing or unparseable
// value is hidden rather than guessed at.
function remainingLabel(deadline: string): string {
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return "已到期";
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `剩余 ${hours} 小时 ${rest} 分钟` : `剩余 ${hours} 小时`;
}

// Mounted with the full space/computer key. Never transfer an operation or
// incarnation to another card; mutations are only triggered by explicit clicks.
export function ComputerRuntimeControls({ base, name, provider = "server" }: { base: string; name: string; provider?: string }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
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
  async function act(action: "reserve" | "refresh" | "approve" | "reconcile" | "replace") {
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
            method: "POST", json: { incarnation: runtime.incarnation, createOperationId: runtime.createOperationId, confirm: action === "approve" || action === "replace" },
          }));
          setUncertain(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "运行环境操作失败");
      if (runtime && (action === "approve" || action === "reconcile" || action === "replace")) {
        // Read-only recovery; never silently resend a creation request.
        try { await read(runtime); } catch { setUncertain(true); }
      }
    } finally { lock.current = false; setBusy(false); }
  }
  const manifest = runtime?.manifest;
  const deadline = manifest?.deadline ? remainingLabel(manifest.deadline) : "";
  const terminal = runtime?.state === "ready" && TERMINAL_PROVIDERS.has(provider);
  return <div className="mt-3 space-y-3 border-t pt-3">
    {runtime && <p role="status" className="text-xs text-muted-foreground"><span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground">{uncertain ? "状态未确认，请刷新" : states[runtime.state] ?? runtime.state}</span>{!runtime.executionAvailable && <span className="ml-2">执行通道尚未接通</span>}</p>}
    {manifest && (manifest.preview || manifest.claim || deadline) && <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {manifest.preview && <a href={manifest.preview} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2 hover:text-foreground">预览：{manifest.preview}</a>}
      {manifest.claim && <a href={manifest.claim} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2 hover:text-foreground">认领：{manifest.claim}</a>}
      {deadline && <span>{deadline}</span>}
    </p>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {!runtime ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reserve")}>{busy ? "读取中…" : "准备 / 查看运行环境"}</Button> : <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("refresh")}>刷新状态</Button>
        {runtime.state === "pending_approval" && !uncertain && <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>创建运行环境</Button>}
        {["unknown", "creating"].includes(runtime.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reconcile")}>核实创建结果</Button>}
        {runtime.state === "unknown" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("replace")}>重建运行环境</Button>}
        {terminal && <Button size="sm" variant="outline" onClick={() => setTerminalOpen(true)}><Terminal className="size-4" />终端</Button>}
      </>}
    </div>
    {runtime && ["unknown", "creating"].includes(runtime.state) && <p className="text-xs text-muted-foreground">核实只查找本次创建的环境，不会创建第二个容器。</p>}
    <Dialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <DialogContent><DialogHeader><DialogTitle>创建 {name} 的运行环境？</DialogTitle><DialogDescription>将在所选服务器上创建独立容器和数据卷，占用服务器资源。不会替换已有电脑或共用其文件。当前执行通道尚未接通，创建后仍不能用于对话执行。</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button disabled={busy || uncertain || runtime?.state !== "pending_approval"} onClick={() => void act("approve")}>确认创建</Button></div>
      </DialogContent>
    </Dialog>
    <WorkspaceTerminalDialog
      open={terminalOpen}
      ticketPath={`${base}/terminal-ticket`}
      onOpenChange={setTerminalOpen}
    />
  </div>;
}
