"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Monitor } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { listRuntimeNodes, type RuntimeNode } from "@/lib/runners";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ComputerRuntimeControls } from "@/components/computer-runtime-controls";
import { ComputerSelector } from "@/components/computer-selector";
import { SettingsHeader } from "@/components/settings-shell";

const providers = { server: "服务器电脑", remote_agent: "远程电脑", ssh: "SSH 电脑", temporary: "临时电脑", e2b: "E2B", railway: "Railway VM" };
type Provider = keyof typeof providers;
type Computer = { id: string; name: string; provider: Provider; runtimeNodeId?: string; capabilities: string[]; idleSeconds: number; maxLifetimeSeconds: number };
const fields: Partial<Record<Provider, string[]>> = { e2b: ["apiKey", "template"], ssh: ["host", "user", "port", "privateKey", "hostKeyFingerprint"], railway: ["privateKey", "hostKeyFingerprint"] };
const labels: Record<string, string> = { apiKey: "API Key", template: "模板", host: "主机", user: "SSH 用户", port: "端口（可选）", privateKey: "SSH 私钥", hostKeyFingerprint: "主机指纹（SHA256）" };
const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm";

export function ComputerCatalog({ spaceId }: { spaceId: string }) {
  const [items, setItems] = useState<Computer[]>([]);
  const [nodes, setNodes] = useState<RuntimeNode[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>("server");
  const [name, setName] = useState("");
  const [node, setNode] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const base = `/api/spaces/${encodeURIComponent(spaceId)}/computers`;
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setItems(await api<Computer[]>(base, { cacheTtlMs: false })); }
    catch (e) { setError(e instanceof Error ? e.message : "加载电脑失败"); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRuntimeNodes().then(v => { if (!cancelled) setNodes(v); }).catch(() => { if (!cancelled) setNodes([]); });
    return () => { cancelled = true; };
  }, [open]);
  const local = provider === "server" || provider === "remote_agent" || provider === "temporary";
  const available = nodes.filter(n => provider === "remote_agent" || n.kind === "server");
  function close(value: boolean) {
    if (busy) return;
    setOpen(value);
    if (!value) { setConfig({}); setName(""); setNode(""); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(base, { method: "POST", json: { name, provider, runtimeNodeId: local ? node : "", config, idleSeconds: 900, maxLifetimeSeconds: 3600 } });
      setConfig({}); setName(""); setNode(""); setOpen(false);
      toast.success("电脑配置已添加；尚未创建运行环境"); await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "添加失败"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4">
    <SettingsHeader title="电脑" description="每台电脑独立配置。添加配置不会启动环境或产生云端费用。" actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" />添加电脑</Button>} />
    <ComputerSelector key={`${spaceId}:${items.length}`} selectionUrl={`/api/spaces/${encodeURIComponent(spaceId)}/computer-default`} catalogUrl={base} label="Space 默认电脑" hint="只用于新建对话；已有对话保留自己的选择。" />
    {error ? <div role="alert" className="rounded-md border p-4 text-sm text-destructive">{error}<Button variant="ghost" onClick={() => void load()}>重试</Button></div> : loading ? <p className="text-sm text-muted-foreground">正在加载电脑…</p> : items.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">暂无电脑配置，点击右上角添加。</p> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map(c => <article key={c.id} className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3"><Monitor className="mt-1 size-5 shrink-0 text-muted-foreground" /><div className="min-w-0"><h3 className="truncate font-medium" title={c.name}>{c.name}</h3><p className="mt-1 text-xs text-muted-foreground">{providers[c.provider] ?? c.provider}</p></div></div>
      <p className="mt-4 text-xs text-muted-foreground">{c.id.startsWith("legacy:") ? "现有工作区 · 在下方管理" : "已配置 · 执行适配尚未接通"}</p>
      {(c.provider === "temporary" || c.provider === "e2b") && <p className="mt-2 text-xs text-muted-foreground">按对话隔离 · 空闲 {Math.round(c.idleSeconds / 60)} 分钟 · 最长 {Math.round(c.maxLifetimeSeconds / 60)} 分钟；到期文件不保留。</p>}
      {c.provider === "server" && !c.id.startsWith("legacy:") && <ComputerRuntimeControls key={`${spaceId}:${c.id}`} base={`${base}/${encodeURIComponent(c.id)}`} name={c.name} />}
    </article>)}</div>}
    <Dialog open={open} onOpenChange={close}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>添加电脑</DialogTitle></DialogHeader><form onSubmit={create} className="space-y-4">
      <label className="block space-y-2 text-sm"><span>类型</span><select className={selectClass} value={provider} disabled={busy} onChange={e => { setProvider(e.target.value as Provider); setConfig({}); setNode(""); }}>{Object.entries(providers).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="block space-y-2 text-sm"><span>名称</span><Input required value={name} disabled={busy} maxLength={200} onChange={e => setName(e.target.value)} placeholder="例如：开发电脑" /></label>
      {local && <label className="block space-y-2 text-sm"><span>运行设备</span><select className={selectClass} required disabled={busy} value={node} onChange={e => setNode(e.target.value)}><option value="">选择设备</option>{available.map(n => <option key={n.id} value={n.id}>{n.name} · {n.status}</option>)}</select></label>}
      {(fields[provider] ?? []).map(key => <label key={key} className="block space-y-2 text-sm"><span>{labels[key]}</span>{key === "privateKey" ? <textarea className="min-h-28 w-full rounded-md border bg-background p-3 font-mono text-xs" required autoComplete="off" spellCheck={false} disabled={busy} value={config[key] ?? ""} onChange={e => setConfig(v => ({...v, [key]: e.target.value}))} /> : <Input required={key !== "port"} type={key === "apiKey" ? "password" : "text"} autoComplete="off" disabled={busy} value={config[key] ?? ""} onChange={e => setConfig(v => { const next = {...v}; if (key === "port" && !e.target.value) delete next[key]; else next[key] = e.target.value; return next; })} />}</label>)}
      <p className="text-xs text-muted-foreground">凭据加密保存且不会回显。当前仅保存配置，不表示环境已就绪。{provider === "railway" && " Railway 相同 SSH 密钥对应相同 VM。"}</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>取消</Button><Button type="submit" disabled={busy || !name.trim() || (local && !node)}>{busy ? "保存中…" : "添加"}</Button></div>
    </form></DialogContent></Dialog>
  </section>;
}
