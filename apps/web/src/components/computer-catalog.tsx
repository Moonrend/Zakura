"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Clock,
  Cloud,
  Container,
  Monitor,
  Plus,
  Server,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  kindLabel,
  listRuntimeNodes,
  statusLabel,
  statusVariant,
  type RuntimeNode,
} from "@/lib/runners";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FluidItem, FluidList } from "@/components/ui/fluid-hover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ComputerRuntimeControls } from "@/components/computer-runtime-controls";
import { ComputerSelector } from "@/components/computer-selector";
import { SettingsHeader } from "@/components/settings-shell";
import { cn } from "@/lib/utils";

type Provider = "server" | "remote_agent" | "ssh" | "temporary" | "e2b" | "railway";
type Computer = {
  id: string;
  name: string;
  provider: Provider;
  runtimeNodeId?: string;
  capabilities: string[];
  idleSeconds: number;
  maxLifetimeSeconds: number;
};

const PROVIDERS: { id: Provider; label: string; description: string; icon: LucideIcon }[] = [
  { id: "server", label: "服务器电脑", description: "绑定服务器节点，长期运行", icon: Server },
  { id: "remote_agent", label: "远程电脑", description: "经远程代理接入任意节点", icon: Monitor },
  { id: "ssh", label: "SSH 电脑", description: "连接已有 SSH 主机", icon: Terminal },
  { id: "temporary", label: "临时电脑", description: "按对话隔离，到期销毁", icon: Clock },
  { id: "e2b", label: "E2B", description: "托管沙箱环境", icon: Cloud },
  { id: "railway", label: "Railway VM", description: "托管虚拟机，自动生成密钥", icon: Container },
];
const providerLabel = (p: Provider) =>
  PROVIDERS.find((x) => x.id === p)?.label ?? p;
const providerIcon = (p: Provider) =>
  PROVIDERS.find((x) => x.id === p)?.icon ?? Monitor;

export function ComputerCatalog({ spaceId }: { spaceId: string }) {
  const [items, setItems] = useState<Computer[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const base = `/api/spaces/${encodeURIComponent(spaceId)}/computers`;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await api<Computer[]>(base, { cacheTtlMs: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载电脑失败");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-4">
      <SettingsHeader
        title="电脑"
        description="每台电脑独立配置。添加配置不会启动环境或产生云端费用。"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            添加电脑
          </Button>
        }
      />

      <ComputerSelector
        key={`${spaceId}:${items.length}`}
        selectionUrl={`/api/spaces/${encodeURIComponent(spaceId)}/computer-default`}
        catalogUrl={base}
        label="Space 默认电脑"
        hint="只用于新建对话；已有对话保留自己的选择。"
      />

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <span className="min-w-0 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          正在加载电脑…
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            还没有电脑。添加一台，供对话运行命令与文件任务。
          </p>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            添加电脑
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <ComputerCard key={c.id} computer={c} spaceId={spaceId} base={base} />
          ))}
        </div>
      )}

      <AddComputerDialog
        open={open}
        onOpenChange={setOpen}
        spaceId={spaceId}
        onCreated={load}
      />
    </section>
  );
}

function ComputerCard({
  computer: c,
  spaceId,
  base,
}: {
  computer: Computer;
  spaceId: string;
  base: string;
}) {
  const legacy = c.id.startsWith("legacy:");
  const Icon = providerIcon(c.provider);
  const note = legacy
    ? "保留自旧版工作区，可继续在对话中使用。"
    : c.provider === "temporary" || c.provider === "e2b"
      ? `按对话隔离 · 空闲 ${Math.round(c.idleSeconds / 60)} 分钟 · 最长 ${Math.round(c.maxLifetimeSeconds / 60)} 分钟；到期文件不保留。`
      : c.provider === "server"
        ? "绑定服务器节点，按需创建独立运行环境。"
        : c.provider === "ssh"
          ? "通过 SSH 密钥连接；主机指纹在首次连接时锁定。"
          : "自动生成的 SSH 密钥即身份；预览与认领链接见运行环境状态。";
  return (
    <article className="flex flex-col rounded-xl bg-card p-4 shadow-surface-2">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium" title={c.name}>
            {c.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {legacy ? "原有工作区" : providerLabel(c.provider)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{note}</p>
      {!legacy && (c.provider === "server" || c.provider === "ssh" || c.provider === "railway") && (
        <ComputerRuntimeControls
          key={`${spaceId}:${c.id}`}
          base={`${base}/${encodeURIComponent(c.id)}`}
          name={c.name}
          provider={c.provider}
        />
      )}
    </article>
  );
}

function AddComputerDialog({
  open,
  onOpenChange,
  spaceId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  spaceId: string;
  onCreated: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<Provider>("server");
  const [name, setName] = useState("");
  const [node, setNode] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/spaces/${encodeURIComponent(spaceId)}/computers`;

  const loadNodes = useCallback(async () => {
    setNodesLoading(true);
    setNodesError("");
    try {
      setNodes(await listRuntimeNodes());
    } catch (e) {
      setNodesError(e instanceof Error ? e.message : "加载设备失败");
    } finally {
      setNodesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadNodes();
  }, [open, loadNodes]);

  useEffect(() => {
    if (open) return;
    setProvider("server");
    setName("");
    setNode("");
    setConfig({});
  }, [open]);

  const local =
    provider === "server" || provider === "temporary" || provider === "remote_agent";
  const available = nodes.filter((n) =>
    provider === "remote_agent"
      ? true
      : n.kind === "server" || n.kind === "computer" || n.kind === "local",
  );

  function handleOpenChange(next: boolean) {
    if (busy && !next) return;
    onOpenChange(next);
  }
  function pick(p: Provider) {
    setProvider(p);
    setConfig({});
    setNode("");
  }
  function setField(key: string, value: string) {
    setConfig((v) => ({ ...v, [key]: value }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(config).filter(([, v]) => v.trim() !== ""),
      );
      await api(base, {
        method: "POST",
        json: {
          name,
          provider,
          runtimeNodeId: local ? node : "",
          idleSeconds: 900,
          maxLifetimeSeconds: 3600,
          config: payload,
        },
      });
      toast.success("电脑配置已添加；尚未创建运行环境");
      await onCreated();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加电脑</DialogTitle>
          <DialogDescription>
            选择类型并填写连接信息。添加后只有配置，不会立即启动环境或产生费用。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={create} className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">类型</p>
            <FluidList
              axis="xy"
              gapClick={{ maxDistance: 16 }}
              className="grid gap-2 sm:grid-cols-3"
              highlightClassName="rounded-xl"
            >
              {PROVIDERS.map((p) => {
                const selected = provider === p.id;
                const Icon = p.icon;
                return (
                  <FluidItem key={p.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => pick(p.id)}
                      className={cn(
                        "flex h-full w-full flex-col items-start gap-1 rounded-xl p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
                        selected ? "bg-selected/50" : "hover:bg-hover",
                      )}
                    >
                      <Icon className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.description}
                      </span>
                    </button>
                  </FluidItem>
                );
              })}
            </FluidList>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="computer-name">名称</Label>
            <Input
              id="computer-name"
              required
              autoFocus
              maxLength={200}
              disabled={busy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：开发电脑"
            />
          </div>

          {provider === "ssh" && (
            <div className="space-y-1.5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-host">主机</Label>
                  <Input
                    id="ssh-host"
                    required
                    autoComplete="off"
                    disabled={busy}
                    value={config.host ?? ""}
                    onChange={(e) => setField("host", e.target.value)}
                    placeholder="10.0.0.5 或 host.example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-user">SSH 用户</Label>
                  <Input
                    id="ssh-user"
                    required
                    autoComplete="off"
                    disabled={busy}
                    value={config.user ?? ""}
                    onChange={(e) => setField("user", e.target.value)}
                    placeholder="root"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-port">端口（可选）</Label>
                  <Input
                    id="ssh-port"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={busy}
                    value={config.port ?? ""}
                    onChange={(e) => setField("port", e.target.value)}
                    placeholder="22"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-fingerprint">主机指纹（SHA256）</Label>
                  <Input
                    id="ssh-fingerprint"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    value={config.hostKeyFingerprint ?? ""}
                    onChange={(e) => setField("hostKeyFingerprint", e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-key">SSH 私钥</Label>
                <Textarea
                  id="ssh-key"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  className="min-h-28 font-mono text-xs"
                  value={config.privateKey ?? ""}
                  onChange={(e) => setField("privateKey", e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </div>
            </div>
          )}

          {provider === "e2b" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="e2b-key">API Key</Label>
                <Input
                  id="e2b-key"
                  type="password"
                  required
                  autoComplete="off"
                  disabled={busy}
                  value={config.apiKey ?? ""}
                  onChange={(e) => setField("apiKey", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="e2b-template">模板</Label>
                <Input
                  id="e2b-template"
                  required
                  autoComplete="off"
                  disabled={busy}
                  value={config.template ?? ""}
                  onChange={(e) => setField("template", e.target.value)}
                />
              </div>
            </div>
          )}

          {provider === "railway" && (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              系统将自动生成 SSH 密钥；首次连接时记录主机指纹，之后自动校验。
            </p>
          )}

          {local && (
            <div className="space-y-2">
              <p className="text-sm font-medium">运行设备</p>
              {nodesLoading ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  正在加载设备…
                </p>
              ) : nodesError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  <span className="min-w-0 break-words">{nodesError}</span>
                  <Button variant="outline" size="sm" onClick={() => void loadNodes()}>
                    重试
                  </Button>
                </div>
              ) : available.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {provider === "remote_agent"
                    ? "没有可用节点，请先在电脑与服务器页注册。"
                    : "没有可承载的服务器或电脑节点。"}
                </p>
              ) : (
                <FluidList
                  axis="xy"
                  gapClick={{ maxDistance: 16 }}
                  className="grid gap-2 sm:grid-cols-2"
                  highlightClassName="rounded-xl"
                >
                  {available.map((n) => {
                    const online = n.status === "online";
                    const selected = node === n.id;
                    return (
                      <FluidItem key={n.id}>
                        <button
                          type="button"
                          disabled={busy || !online}
                          aria-pressed={selected}
                          onClick={() => setNode(n.id)}
                          className={cn(
                            "flex h-full w-full flex-col gap-2 rounded-xl p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                            selected ? "bg-selected/50" : "hover:bg-hover",
                            !online && "cursor-not-allowed opacity-60",
                          )}
                        >
                          <span className="truncate text-sm font-medium" title={n.name}>
                            {n.name}
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">{kindLabel(n.kind)}</Badge>
                            <Badge variant={statusVariant(n.status)}>
                              {statusLabel(n.status)}
                            </Badge>
                          </span>
                        </button>
                      </FluidItem>
                    );
                  })}
                </FluidList>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            凭据加密保存且不会回显。当前仅保存配置，不表示环境已就绪。
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || (local && !node)}
            >
              {busy ? "添加中…" : "添加电脑"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
