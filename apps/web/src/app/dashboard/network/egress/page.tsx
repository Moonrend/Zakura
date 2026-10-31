"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";
import { useMeOptional } from "@/components/me-context";
import { listRuntimeNodes, type RuntimeNode } from "@/lib/runners";
import { fetchEgressPresets, fetchNodeEgress, saveNodeEgress, type EgressMode, type EgressPresets, type NodeEgressState } from "@/lib/node-egress";

const MODES: { value: EgressMode; label: string; hint: string }[] = [
  { value: "off", label: "不限制", hint: "容器使用 Docker 默认网络，可以访问任意地址（仍然禁止特权容器）。" },
  { value: "allow", label: "默认放行", hint: "放行所有目的地，只拦截下方拒绝列表和内置拒绝规则。" },
  { value: "deny", label: "默认拒绝", hint: "只放行允许列表中的目的地，其余全部拦截。" },
];

const PRESET_LABEL: Record<string, string> = { open: "全部放行", balanced: "常用开发站点", locked: "完全锁定" };

const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);

export default function NodeEgressPage() {
  const me = useMeOptional();
  const [nodes, setNodes] = useState<RuntimeNode[] | null>(null);
  const [nodeId, setNodeId] = useState("");
  const [presets, setPresets] = useState<EgressPresets | null>(null);
  const [state, setState] = useState<NodeEgressState | null>(null);
  const [mode, setMode] = useState<EgressMode>("off");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [noUpstream, setNoUpstream] = useState("");
  const [upstream, setUpstream] = useState("");
  const [editingUpstream, setEditingUpstream] = useState(false);
  const [logAllowed, setLogAllowed] = useState(false);
  const [busy, setBusy] = useState(false);

  // 只有节点所属租户能管理出口策略；借用的共享节点不在此列。
  const owned = useMemo(() => (nodes ?? []).filter(node => node.kind !== "local" && node.tenantId === me?.tenant?.id), [nodes, me]);

  useEffect(() => {
    void Promise.all([listRuntimeNodes(), fetchEgressPresets()]).then(([list, p]) => {
      setNodes(list);
      setPresets(p);
    }).catch(err => toast.error(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(() => {
    if (!nodeId && owned.length) setNodeId(owned[0].id);
  }, [owned, nodeId]);

  const load = useCallback(async (id: string) => {
    const next = await fetchNodeEgress(id);
    setState(next);
    setMode(next.policy.mode);
    setAllow((next.policy.allow ?? []).join("\n"));
    setDeny((next.policy.deny ?? []).join("\n"));
    setNoUpstream((next.policy.noUpstream ?? []).join("\n"));
    setUpstream(next.policy.upstream ?? "");
    setEditingUpstream(!next.meta.hasUpstream);
    setLogAllowed(next.policy.logAllowed);
  }, []);
  useEffect(() => {
    if (!nodeId) return;
    setState(null);
    void load(nodeId).catch(err => toast.error(err instanceof Error ? err.message : String(err)));
  }, [nodeId, load]);

  function applyPreset(key: string) {
    const preset = presets?.presets[key];
    if (!preset) return;
    setMode(preset.mode);
    setAllow((preset.allow ?? []).join("\n"));
  }

  async function save() {
    if (!nodeId) return;
    setBusy(true);
    try {
      const keepUpstream = Boolean(state?.meta.hasUpstream) && !editingUpstream;
      const res = await saveNodeEgress(nodeId, {
        mode, allow: lines(allow), deny: lines(deny), noUpstream: lines(noUpstream), logAllowed,
        upstream: keepUpstream ? "" : upstream.trim(), keepUpstream,
      });
      if (res.applied) toast.success("已保存并下发到节点");
      else toast.warning(`已保存，节点未生效：${res.applyError ?? "节点离线"}。节点上线后会自动下发。`);
      await load(nodeId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!nodes || !presets) return <PageLoading />;

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="出口策略"
        description="控制节点上所有容器（工作区、MCP、ACP）能访问哪些外部地址，以及经由哪个上游代理出网。节点在内部网络中运行容器，唯一出口是节点内置的过滤代理。"
      />
      {owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          没有可管理的节点。出口策略只能由节点所属的租户设置，请先在<Link className="mx-1 underline" href="/dashboard/runners">设备</Link>页面连接节点。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 space-y-2">
              <Label htmlFor="egress-node">节点</Label>
              <select id="egress-node" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nodeId} onChange={event => setNodeId(event.target.value)}>
                {owned.map(node => <option key={node.id} value={node.id}>{node.name}{node.status !== "online" ? "（离线）" : ""}</option>)}
              </select>
            </div>
            {state ? (
              <p className="pb-2 text-xs text-muted-foreground">
                {state.meta.applyError ? <span className="text-destructive">未生效：{state.meta.applyError}</span>
                  : state.meta.appliedAt ? `已于 ${new Date(state.meta.appliedAt).toLocaleString()} 生效`
                  : state.meta.updatedAt ? "已保存，等待节点上线后生效" : "尚未配置"}
              </p>
            ) : null}
          </div>

          {!state ? <PageLoading /> : (
            <>
              <SettingsSection title="模式" description="修改只影响新建的容器；正在运行的容器需要重启工作区后才会进入受控网络。">
                <div className="space-y-2">
                  {MODES.map(item => (
                    <label key={item.value} className="flex items-start gap-2 text-sm">
                      <input type="radio" className="mt-1" name="egress-mode" checked={mode === item.value} onChange={() => setMode(item.value)} />
                      <span><span className="font-medium">{item.label}</span><span className="block text-xs text-muted-foreground">{item.hint}</span></span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  {Object.keys(presets.presets).map(key => (
                    <Button key={key} size="sm" variant="outline" onClick={() => applyPreset(key)}>套用「{PRESET_LABEL[key] ?? key}」</Button>
                  ))}
                </div>
              </SettingsSection>

              <SettingsSection title="规则" description="每行一条：域名（api.example.com）、子域通配（*.example.com）、含根域通配（**.example.com）、IP 段（10.0.0.0/8）或带端口（example.com:443）。拒绝规则永远优先。">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="egress-allow">允许列表{mode !== "deny" ? "（默认拒绝模式下生效）" : ""}</Label>
                    <textarea id="egress-allow" className="min-h-40 w-full rounded-md border bg-background p-2 font-mono text-xs" value={allow} onChange={event => setAllow(event.target.value)} spellCheck={false} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="egress-deny">拒绝列表</Label>
                    <textarea id="egress-deny" className="min-h-40 w-full rounded-md border bg-background p-2 font-mono text-xs" value={deny} onChange={event => setDeny(event.target.value)} spellCheck={false} />
                  </div>
                </div>
                <div className="space-y-1 pt-2">
                  <p className="text-xs font-medium">内置拒绝（不可删除）</p>
                  <p className="font-mono text-xs text-muted-foreground">{presets.builtinDeny.join("  ")}</p>
                  <p className="text-xs text-muted-foreground">覆盖各云厂商元数据服务和节点本机地址。代理会检查域名解析出的每个 IP，域名指向这些地址同样会被拦截。</p>
                </div>
              </SettingsSection>

              <SettingsSection title="上游代理" description="可选。节点处于企业内网时，经由此代理出网；支持 http:// 与 socks5://，可带用户名密码。">
                {state.meta.hasUpstream && !editingUpstream ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm">{state.policy.upstream}</span>
                    <Button size="sm" variant="outline" onClick={() => { setEditingUpstream(true); setUpstream(""); }}>更换</Button>
                  </div>
                ) : (
                  <Input placeholder="http://user:password@proxy.corp:8080，留空表示直连" value={upstream} onChange={event => setUpstream(event.target.value)} autoComplete="off" />
                )}
                <div className="space-y-2 pt-3">
                  <Label htmlFor="egress-no-upstream">不经上游代理直连（每行一条）</Label>
                  <textarea id="egress-no-upstream" className="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs" value={noUpstream} onChange={event => setNoUpstream(event.target.value)} spellCheck={false} />
                </div>
              </SettingsSection>

              <SettingsSection title="记录">
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span>同时记录放行的连接<span className="block text-xs text-muted-foreground">拦截的连接始终记录。</span></span>
                  <Switch checked={logAllowed} onCheckedChange={setLogAllowed} />
                </label>
                {state.live ? (
                  <div className="space-y-2 pt-3">
                    <p className="text-xs text-muted-foreground">代理 {state.live.proxy || "未启用"}，累计放行 {state.live.allowed}、拦截 {state.live.denied}</p>
                    <ul className="max-h-72 divide-y overflow-auto text-xs">
                      {(state.live.recent ?? []).slice().reverse().map((d, i) => (
                        <li key={i} className="flex flex-wrap gap-x-3 py-1.5">
                          <span className="text-muted-foreground">{new Date(d.time).toLocaleTimeString()}</span>
                          <span className={d.allowed ? "" : "text-destructive"}>{d.allowed ? "放行" : "拦截"}</span>
                          <span className="font-mono">{d.host}:{d.port}</span>
                          <span className="text-muted-foreground">{d.reason}</span>
                        </li>
                      ))}
                      {!state.live.recent?.length ? <li className="py-1.5 text-muted-foreground">暂无记录</li> : null}
                    </ul>
                  </div>
                ) : <p className="pt-3 text-xs text-muted-foreground">节点离线，无法读取实时记录。</p>}
              </SettingsSection>

              <div className="flex justify-end">
                <Button disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存并下发"}</Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
