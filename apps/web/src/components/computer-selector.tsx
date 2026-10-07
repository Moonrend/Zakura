"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

type ComputerOption = { id: string; name: string; provider: string };
type Selection = { computerId: string | null };

// Mount with an identity key: pending requests must never update another chat.
export function ComputerSelector({ selectionUrl, catalogUrl, label, hint }: {
  selectionUrl: string;
  catalogUrl: string;
  label: string;
  hint: string;
}) {
  const [items, setItems] = useState<ComputerOption[]>([]);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setError("");
    Promise.all([
      api<ComputerOption[]>(catalogUrl, { cacheTtlMs: false }),
      api<Selection>(selectionUrl, { cacheTtlMs: false }),
    ]).then(([computers, selection]) => {
      if (current !== generation.current) return;
      setItems(computers); setValue(selection.computerId ?? "");
    }).catch(e => {
      if (current === generation.current) setError(e instanceof Error ? e.message : "加载电脑选择失败");
    }).finally(() => {
      if (current === generation.current) setLoading(false);
    });
    return () => { generation.current++; };
  }, [selectionUrl, catalogUrl, retry]);

  async function select(computerId: string) {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    const current = generation.current;
    try {
      const result = await api<Selection>(selectionUrl, { method: "PUT", json: { computerId: computerId || null } });
      if (current === generation.current) setValue(result.computerId ?? "");
    } catch (e) {
      if (current === generation.current) toast.error(e instanceof Error ? e.message : "切换失败");
    } finally {
      saving.current = false;
      if (current === generation.current) setBusy(false);
    }
  }
  return <div className="space-y-1.5 text-xs">
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <select aria-label={label} disabled={loading || busy || Boolean(error)} value={value} onChange={e => void select(e.target.value)} className="h-8 max-w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50">
        <option value="">{loading ? "正在加载…" : "不使用电脑"}</option>
        {value && !items.some(c => c.id === value) && <option value={value}>当前电脑不可用</option>}
        {items.map(c => <option key={c.id} value={c.id}>{c.name} · {c.provider}{c.id.startsWith("legacy:") ? "" : "（执行未接通）"}</option>)}
      </select>
      {busy && <span role="status">正在保存…</span>}
    </label>
    {error ? <p role="alert" className="text-destructive">{error} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>重试</button></p> : <p className="text-muted-foreground">{hint}</p>}
  </div>;
}
