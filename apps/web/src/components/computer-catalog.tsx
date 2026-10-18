"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  type RuntimeNode,
} from "@/lib/runners";
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
import { SettingsHeader } from "@/components/settings-shell";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

type Provider = "server" | "remote_agent" | "ssh" | "temporary" | "e2b" | "railway";
type Computer = {
  id: string;
  name: string;
  provider: Provider;
  role?: "server" | "attached";
  workspaceKind?: "container" | "host" | "local";
  runtimeNodeId?: string;
  capabilities: string[];
  idleSeconds: number;
  maxLifetimeSeconds: number;
};

// The Space server computer is created with the Space and cannot be added here.
type AttachedProvider = Exclude<Provider, "server">;
const PROVIDERS: { id: AttachedProvider; label: string; description: string; icon: LucideIcon }[] = [
  { id: "remote_agent", label: "远程电脑", description: "经远程代理接入任意节点", icon: Monitor },
  { id: "ssh", label: "SSH 电脑", description: "连接已有 SSH 主机", icon: Terminal },
  { id: "temporary", label: "临时电脑", description: "按对话隔离，到期销毁", icon: Clock },
  { id: "e2b", label: "E2B", description: "托管沙箱环境", icon: Cloud },
  { id: "railway", label: "Railway VM", description: "托管虚拟机，自动生成密钥", icon: Container },
];
const providerLabel = (p: Provider) =>
  p === "server" ? "服务器电脑" : (PROVIDERS.find((x) => x.id === p)?.label ?? p);
const providerIcon = (p: Provider) =>
  p === "server" ? Server : (PROVIDERS.find((x) => x.id === p)?.icon ?? Monitor);
const workspaceKindLabel = (kind?: Computer["workspaceKind"]) =>
  kind === "container" ? "运行在工作区容器中" : kind === "host" ? "运行在节点宿主机上" : "尚未绑定运行节点，暂只能浏览文件";

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

  const attached = items.filter((c) => c.role !== "server" && c.provider !== "server");

  return (
    <section className="space-y-4">
      <SettingsHeader
        title="其他电脑"
        description="在对话中选用的附加电脑，不改变工作区节点。"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            添加电脑
          </Button>
        }
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
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {attached.map((c) => (
            <ComputerCard key={c.id} computer={c} spaceId={spaceId} base={base} onChanged={load} />
          ))}
          {attached.length === 0 && (
            <div className="flex flex-col items-start justify-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              <p>还没有附加电脑。需要隔离环境、外部主机或云端沙箱时再添加。</p>
              <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                添加电脑
              </Button>
            </div>
          )}
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
  onChanged,
}: {
  computer: Computer;
  spaceId: string;
  base: string;
  onChanged: () => Promise<void>;
}) {
  const { confirm } = useConfirmDialog();
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(c.name);
  const [editing, setEditing] = useState(false);
  const [savingName, setSavingName] = useState(false);
  async function rename() {
    if (!draftName.trim() || savingName) return;
    setSavingName(true);
    try {
      await api(`${base}/${encodeURIComponent(c.id)}`, { method: "PATCH", json: { name: draftName.trim() } });
      setRenaming(false);
      await onChanged();
    } catch (err) { toast.error(err instanceof Error ? err.message : "改名失败"); }
    finally { setSavingName(false); }
  }
  const isServer = c.role === "server";
  const Icon = providerIcon(c.provider);
  const note = isServer
    ? `本 Space 的工作区：默认文件系统、ACP 与技能都在这里；未指定电脑的对话都在此运行。${workspaceKindLabel(c.workspaceKind)}。`
    : c.provider === "temporary" || c.provider === "e2b"
      ? `按对话隔离 · 空闲 ${Math.round(c.idleSeconds / 60)} 分钟 · 最长 ${Math.round(c.maxLifetimeSeconds / 60)} 分钟；到期文件不保留。`
      : c.provider === "ssh"
        ? "通过 SSH 密钥连接；主机指纹在首次连接时锁定。"
        : c.provider === "remote_agent"
          ? "经远程代理接入的节点。"
          : "自动生成的 SSH 密钥即身份；预览与认领链接见运行环境状态。";

  async function remove() {
    const ok = await confirm({
      title: `移除「${c.name}」？`,
      description: c.provider === "e2b" || c.provider === "temporary"
        ? "选用它的对话将改回服务器电脑，已有环境和文件将由后台回收。正在执行的对话结束后才能移除。"
        : "选用它的对话将改回服务器电脑。只移除连接配置，外部主机仍会保留。正在执行的对话结束后才能移除。",
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await api(`${base}/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      toast.success("电脑已移除");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失败");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <article className="flex flex-col rounded-xl bg-card p-4 shadow-surface-2">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {renaming ? <form className="flex flex-wrap gap-1" onSubmit={event => { event.preventDefault(); void rename(); }}><Input aria-label="电脑名称" autoFocus value={draftName} onChange={event => setDraftName(event.target.value)} /><Button size="sm" type="submit" disabled={savingName}>{savingName ? "保存中…" : "保存"}</Button><Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(false)}>取消</Button></form> : <button type="button" className="max-w-full truncate text-left text-sm font-medium weight-hover" title="重命名" onClick={() => { setDraftName(c.name); setRenaming(true); }}>{c.name}</button>}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isServer ? "服务器电脑 · 工作区" : providerLabel(c.provider)}
          </p>
        </div>
        {!isServer && <Button variant="ghost" size="sm" disabled={removing} onClick={() => setEditing(true)}>编辑</Button>}
        {!isServer && (
          <Button
            variant="ghost"
            size="sm"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? "移除中…" : "移除"}
          </Button>
        )}
      </div>
      <AddComputerDialog open={editing} onOpenChange={setEditing} spaceId={spaceId} computer={c} onCreated={onChanged} />
      <p className="mt-3 text-xs text-muted-foreground">{note}</p>
      {!isServer && (c.provider === "ssh" || c.provider === "railway") && (
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
  computer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  spaceId: string;
  onCreated: () => Promise<void>;
  computer?: Computer;
}) {
  const wasOpen = useRef(false);
  const [provider, setProvider] = useState<AttachedProvider>("ssh");
  const [name, setName] = useState("");
  const [node, setNode] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState("");
  const [busy, setBusy] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const [idleMinutes, setIdleMinutes] = useState(15);
  const [lifetimeMinutes, setLifetimeMinutes] = useState(60);
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
    if (open && (provider === "temporary" || provider === "remote_agent")) void loadNodes();
  }, [open, provider, loadNodes]);

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setProvider(computer?.provider !== "server" ? computer?.provider ?? "ssh" : "ssh");
    setName(computer?.name ?? `电脑-${Math.random().toString(36).slice(2, 6)}`);
    setNode(computer?.runtimeNodeId ?? "");
    setIdleMinutes((computer?.idleSeconds ?? 900) / 60);
    setLifetimeMinutes((computer?.maxLifetimeSeconds ?? 3600) / 60);
    setConfig({});
    setConfigError("");
  }, [open, computer]);

  useEffect(() => {
    if (!open || !computer) return;
    let cancelled = false;
    setConfigLoading(true);
    api<{ config: Record<string, string> }>(`${base}/${encodeURIComponent(computer.id)}/config`, { cacheTtlMs: false })
      .then(result => { if (!cancelled) setConfig(result.config); })
      .catch(err => { if (!cancelled) setConfigError(err instanceof Error ? err.message : "加载配置失败"); })
      .finally(() => { if (!cancelled) setConfigLoading(false); });
    return () => { cancelled = true; };
  }, [open, computer?.id, base]);

  const local = provider === "temporary" || provider === "remote_agent";
  const available = nodes.filter((n) =>
    provider === "remote_agent"
      ? true
      : n.kind === "server" || n.kind === "computer" || n.kind === "local",
  );

  function handleOpenChange(next: boolean) {
    if (busy && !next) return;
    onOpenChange(next);
  }
  function pick(p: AttachedProvider) {
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
      await api(computer ? `${base}/${encodeURIComponent(computer.id)}` : base, {
        method: computer ? "PATCH" : "POST",
        json: {
          name,
          ...(!computer && { provider }),
          runtimeNodeId: local ? node : "",
          idleSeconds: Math.round(idleMinutes * 60),
          maxLifetimeSeconds: Math.round(lifetimeMinutes * 60),
          config: payload,
        },
      });
      toast.success(computer ? "电脑配置已更新" : "电脑配置已添加；尚未创建运行环境");
      await onCreated();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : computer ? "更新失败" : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{computer ? `编辑 ${computer.name}` : "添加电脑"}</DialogTitle>
          <DialogDescription>
            {computer ? "修改连接与环境配置。模板和最长存活时长用于后续创建的环境；密钥留空时保留原值。" : "选择类型并填写连接信息。添加后不会立即启动环境或产生费用。"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={create}>
          <fieldset disabled={busy || configLoading} className="min-w-0 space-y-5">
          {configLoading && <p role="status" className="text-sm text-muted-foreground">正在加载配置…</p>}
          {configError && <p role="alert" className="text-sm text-destructive">{configError}</p>}
          {!computer && <div className="space-y-2">
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
          </div>}

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
                  required={!computer}
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
                  placeholder={computer ? "留空保留现有 API Key" : ""}
                  required={!computer}
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

          {(provider === "e2b" || provider === "temporary") && <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="computer-idle">空闲回收（分钟）</Label>
              <Input id="computer-idle" type="number" min={1} step={1} max={lifetimeMinutes} required disabled={busy} value={idleMinutes} onChange={event => setIdleMinutes(Number(event.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="computer-lifetime">最长存活（分钟）</Label>
              <Input id="computer-lifetime" type="number" min={idleMinutes || 1} step={1} required disabled={busy} value={lifetimeMinutes} onChange={event => setLifetimeMinutes(Number(event.target.value))} />
            </div>
          </div>}

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
                          disabled={busy || (!online && !selected)}
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
                            <span className="text-xs text-muted-foreground">{kindLabel(n.kind)} · {statusLabel(n.status)}</span>
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
            凭据加密保存且不会回显。{computer ? "正在使用的环境会保留原连接凭据。" : provider === "e2b" ? "E2B 环境在选用它的对话中确认创建，每个对话独立计费和回收。" : "当前仅保存配置，不表示环境已就绪。"}
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
              disabled={busy || configLoading || !!configError || !name.trim() || (local && !node) || idleMinutes <= 0 || lifetimeMinutes < idleMinutes}
            >
              {busy ? "保存中…" : computer ? "保存修改" : "添加电脑"}
            </Button>
          </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
