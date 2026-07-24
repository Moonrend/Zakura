"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api";
import {
  fetchAgent,
  fetchAgentProgress,
  getWorkspaceStatus,
  needsContainer,
  type AgentDetail,
} from "@/lib/agents";
import {
  createRuntimeNode,
  fetchRunnerInstall,
  listRuntimeNodes,
  pickInstallPackage,
  statusLabel,
  type RunnerInstallPackage,
  type RuntimeNode,
} from "@/lib/runners";
import { RunnerInstallPanel } from "@/components/runner-install-panel";
import { TailscaleMeshPanel } from "@/components/tailscale-mesh-panel";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Props = {
  agentId: string | null;
  onDone: () => void;
};

function nodeNeedsInstall(node: RuntimeNode | undefined): boolean {
  return Boolean(node && node.kind !== "local" && node.status !== "online");
}

export function StepComputerEnv({ agentId, onDone }: Props) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [percent, setPercent] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [runnerName, setRunnerName] = useState("");
  const [accessMode, setAccessMode] = useState<"public" | "tailscale" | null>(null);
  const [meshReady, setMeshReady] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const [install, setInstall] = useState<RunnerInstallPackage | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === nodeId),
    [nodes, nodeId],
  );
  const showInstall = nodeNeedsInstall(selectedNode);

  const load = useCallback(async () => {
    if (!agentId) {
      setLoading(false);
      return;
    }
    try {
      const [a, ns] = await Promise.all([fetchAgent(agentId), listRuntimeNodes()]);
      setAgent(a);
      setNodes(ns);
      const remotes = ns.filter((n) => n.kind !== "local");
      const local = ns.find((n) => n.kind === "local");
      setNodeId((prev) => {
        if (prev && ns.some((n) => n.id === prev)) return prev;
        if (a.runtimeNodeId && ns.some((n) => n.id === a.runtimeNodeId)) {
          return a.runtimeNodeId;
        }
        return remotes[0]?.id ?? local?.id ?? "";
      });
      if (!remotes.length && !local) setShowRegister(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetchAgentProgress(agentId);
        if (!alive) return;
        setPercent(res.progress.percent);
        setRunning(res.progress.running);
        setAgent((a) =>
          a
            ? { ...a, lastError: res.agent.lastError, workspace: res.workspace }
            : a,
        );
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentId]);

  useEffect(() => {
    if (!showInstall || !selectedNode) {
      setInstall(null);
      setInstallBusy(false);
      return;
    }
    const id = selectedNode.id;
    const enableTailscale = Boolean(selectedNode.labels?.enableTailscale);
    let cancelled = false;
    setInstall(null);
    setInstallBusy(true);
    void fetchRunnerInstall(id)
      .then((res) => {
        if (!cancelled) {
          setInstall(pickInstallPackage(res, enableTailscale));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setInstall(null);
          toast.error(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setInstallBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showInstall, selectedNode?.id, selectedNode?.labels?.enableTailscale]);

  const selectItems = useMemo(() => {
    const remotes = nodes.filter((n) => n.kind !== "local");
    const local = nodes.find((n) => n.kind === "local");
    const items = remotes.map((n) => ({
      value: n.id,
      label: `${n.name}${n.access === "shared" ? " · 共享" : ""} · ${statusLabel(n.status)}`,
    }));
    if (local) {
      items.push({ value: local.id, label: `本机 · ${statusLabel(local.status)}` });
    }
    return items;
  }, [nodes]);

  async function registerRunner() {
    if (!runnerName.trim()) {
      toast.error("请填写 Runner 名称");
      return;
    }
    if (!accessMode) {
      toast.error("请选择访问方式");
      return;
    }
    if (accessMode === "tailscale" && !meshReady) {
      toast.error("请先完成 Tailscale 连接");
      return;
    }
    setRegBusy(true);
    try {
      const res = await createRuntimeNode({
        name: runnerName.trim(),
        enableTailscale: accessMode === "tailscale",
      });
      setShowRegister(false);
      setRunnerName("");
      setAccessMode(null);
      setMeshReady(false);
      setNodeId(res.node.id);
      if (res.install) setInstall(res.install);
      await load();
      toast.success("Runner 已注册");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRegBusy(false);
    }
  }

  async function createComputer() {
    if (!agentId) return;
    if (!nodeId) {
      toast.error("请选择或注册 Runner");
      return;
    }
    setCreating(true);
    try {
      const node = nodes.find((n) => n.id === nodeId);
      const runtimeNodeId = node?.kind === "local" ? null : nodeId;
      await api(`/api/agents/${agentId}`, {
        method: "PATCH",
        json: { enableComputer: true, restart: false },
      });
      await api(`/api/agents/${agentId}/start`, {
        method: "POST",
        json: { runtimeNodeId },
      });
      toast.success("电脑环境已启动");
      await load();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  if (!agentId) {
    return <p className="text-sm text-muted-foreground">请先创建 Agent。</p>;
  }
  if (loading || !agent) {
    return <Skeleton className="h-28 w-full rounded-lg" />;
  }

  const ws = getWorkspaceStatus(agent);
  const hasComputer = needsContainer(agent);

  return (
    <div className="mx-auto max-w-md space-y-4">
      {(creating || running) && (
        <ProgressLinear
          value={creating ? null : percent}
          indeterminate={creating || percent < 5}
        />
      )}

      {hasComputer ? (
        <p className="text-xs text-muted-foreground">
          当前状态：{ws}
          {agent.runtimeNodeId
            ? ` · ${nodes.find((n) => n.id === agent.runtimeNodeId)?.name ?? "Runner"}`
            : " · 本机"}
        </p>
      ) : null}

      {selectItems.length > 0 ? (
        <div className="space-y-1.5">
          <Label>运行位置</Label>
          <Select
            value={nodeId}
            onValueChange={(v) => {
              if (v) setNodeId(v);
            }}
            items={selectItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择 Runner" />
            </SelectTrigger>
            <SelectContent>
              {selectItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">请先注册 Runner。</p>
      )}

      {showInstall ? (
        installBusy && !install ? (
          <Skeleton className="h-36 w-full rounded-lg" />
        ) : install ? (
          <RunnerInstallPanel install={install} compact />
        ) : null
      ) : null}

      {!showRegister ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setShowRegister(true);
            setAccessMode(null);
            setMeshReady(false);
          }}
        >
          <Plus className="size-3.5" />
          注册新 Runner
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1.5">
            <Label>Runner 名称</Label>
            <Input
              placeholder="例如：云主机"
              value={runnerName}
              onChange={(e) => setRunnerName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>访问方式</Label>
            <div className="grid gap-2 grid-cols-2">
              <button
                type="button"
                onClick={() => {
                  setAccessMode("public");
                  setMeshReady(false);
                }}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors",
                  accessMode === "public"
                    ? "border-foreground/40 bg-muted/60"
                    : "border-border/60 hover:bg-muted/30",
                )}
              >
                <div className="font-medium text-xs">有公网</div>
                Server 直连
              </button>
              <button
                type="button"
                onClick={() => setAccessMode("tailscale")}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors",
                  accessMode === "tailscale"
                    ? "border-foreground/40 bg-muted/60"
                    : "border-border/60 hover:bg-muted/30",
                )}
              >
                <div className="font-medium text-xs">无公网</div>
                Tailscale 组网
              </button>
            </div>
          </div>
          {accessMode === "tailscale" ? (
            <TailscaleMeshPanel
              compact
              onStatusChange={(s) => setMeshReady(s.ready)}
            />
          ) : null}
          <Button
            size="sm"
            disabled={
              regBusy ||
              !accessMode ||
              (accessMode === "tailscale" && !meshReady)
            }
            onClick={() => void registerRunner()}
          >
            {regBusy ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5" />}
            创建 Runner
          </Button>
        </div>
      )}

      <Button
        disabled={creating || running || !nodeId}
        onClick={() => void createComputer()}
      >
        {creating || running ? <Loader2 className="animate-spin" /> : null}
        {hasComputer ? "重新启动" : "启用电脑"}
      </Button>
    </div>
  );
}
