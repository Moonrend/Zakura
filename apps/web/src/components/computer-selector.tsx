"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Monitor } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ComputerOption = { id: string; name: string; provider: string; role?: string };
type Selection = { computerId: string | null; serverComputerId?: string };

// The empty value means "follow the Space server computer"; the server computer
// itself is never listed separately because choosing it means the same thing.
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
  const server = items.find(c => c.role === "server");
  const attached = items.filter(c => c.role !== "server");
  const selectedName = value
    ? attached.find(c => c.id === value)?.name ?? "当前电脑不可用"
    : server?.name ?? "工作区";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={loading || busy}
        render={
          <button
            type="button"
            aria-label={label}
            aria-busy={loading || busy}
            title={error || selectedName}
            className="inline-flex h-7 max-w-[min(14rem,60vw)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
          />
        }
      >
        {loading || busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Monitor className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{error ? "电脑不可用" : loading ? "电脑" : selectedName}</span>
        <ChevronDown className="size-3 shrink-0 opacity-45" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-64 max-w-[calc(100vw-2rem)]">
        {error ? (
          <>
            <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{error}</p>
            <DropdownMenuItem onClick={() => setRetry(n => n + 1)}>重试</DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => void select("")}>
              <Monitor className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{server?.name ?? "工作区"}</span>
              <span className="text-xs text-muted-foreground">服务器电脑</span>
              {!value ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
            {value && !attached.some(c => c.id === value) ? (
              <DropdownMenuItem disabled>当前电脑不可用</DropdownMenuItem>
            ) : null}
            {attached.map(c => (
              <DropdownMenuItem key={c.id} onClick={() => void select(c.id)}>
                <Monitor className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.provider}</span>
                {value === c.id ? <Check className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
            <p className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
