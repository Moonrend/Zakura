"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Info = { name: string; bindings: { id: string; agentId: string; name: string; label: string }[] };
function Authorization() {
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [info, setInfo] = useState<Info | null>(null);
  const [tenant, setTenant] = useState("");
  const [email, setEmail] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  async function load(value = code) {
    setError(""); setBusy(true); setInfo(null); setIds([]); setLogin(false);
    try {
      const [data, me] = await Promise.all([
        api<Info>(`/api/zakurabot/authorization?user_code=${encodeURIComponent(value)}`, { cacheTtlMs: false }),
        api<{ tenant: { name: string }; user: { email: string } }>("/api/me", { cacheTtlMs: false }),
      ]);
      setInfo(data); setTenant(me.tenant.name); setEmail(me.user.email);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setLogin(true);
      else setError(cause instanceof Error ? cause.message : "无法读取授权请求");
    } finally { setBusy(false); }
  }
  useEffect(() => { if (params.get("user_code")) void load(params.get("user_code")!); }, [params]);
  async function decide(approve: boolean) {
    setBusy(true); setError("");
    try {
      await api("/api/zakurabot/authorization", { method: "POST", json: { user_code: code, approve, bindingIds: ids } });
      setDone(approve ? "已授权。返回 Zakura Bot，登录会自动完成。" : "已拒绝这次授权。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "授权失败"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 p-6">
    <h1 className="text-2xl font-semibold">连接 Zakura Bot</h1>
    {done ? <p role="status">{done}</p> : <>
      <p>请确认此授权码与 App 显示的一致。选择此设备可以访问的 Bot。</p>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <Input aria-label="设备授权码" value={code} disabled={busy} onChange={(event) => {
          setCode(event.target.value.toUpperCase()); setInfo(null); setIds([]); setLogin(false);
        }} maxLength={32} />
        <Button disabled={busy || !code}>查看</Button>
      </form>
      {login ? <Link className="underline" href={`/login?next=${encodeURIComponent(`/console/zakurabot/authorize?user_code=${encodeURIComponent(code)}`)}`}>登录 Zakura 以继续</Link> : null}
      {info ? <>
        <p className="font-medium">{info.name} · 租户 {tenant}<span className="block text-sm font-normal">{email}</span></p>
        <p className="text-sm text-muted-foreground">设备可发送消息、上传文件、查看所选 Bot 的电脑，并处理该设备会话的批准和提问。授权有效期 90 天，可在平台页撤销。</p>
        {info.bindings.length ? info.bindings.map((binding) => <label key={binding.id} className="flex gap-3 rounded-lg border p-3">
          <input type="checkbox" checked={ids.includes(binding.id)} disabled={busy} onChange={(event) => setIds((previous) => event.target.checked
            ? [...previous.filter((id) => !info.bindings.some((row) => row.id === id && row.agentId === binding.agentId)), binding.id] : previous.filter((id) => id !== binding.id))} />
          <span>{binding.name}<small className="block text-muted-foreground">{binding.label}</small></span>
        </label>) : <p>当前账号没有可授权的 Bot。管理员可在 Agent 平台页启用 Zakura Bot，并将成员的用户 ID 或邮箱加入白名单。</p>}
        <div className="flex gap-3">
          <Button disabled={busy || !ids.length || ids.length > 16} onClick={() => void decide(true)}>授权所选 Bot</Button>
          <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>拒绝</Button>
        </div>
      </> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </>}
  </main>;
}
export default function Page() { return <Suspense fallback={<p>加载中…</p>}><Authorization /></Suspense>; }
