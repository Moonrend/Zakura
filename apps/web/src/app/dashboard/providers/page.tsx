"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

type Provider = {
  id: string;
  name: string;
  description: string;
  version: string;
  category?: string;
  capabilities: string[];
  categoryMeta?: { name: string; description: string } | null;
};

const ORDER = ["web-search", "web-fetch", "memory", "context", "mcp", "runtime"];

export default function ProvidersPage() {
  const [rows, setRows] = useState<Provider[]>([]);

  useEffect(() => {
    void api<Provider[]>("/api/providers").then(setRows);
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, Provider[]>();
    for (const p of rows) {
      const cat = p.category || "mcp";
      const list = map.get(cat) ?? [];
      list.push(p);
      map.set(cat, list);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = ORDER.indexOf(a);
      const ib = ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return keys.map((k) => ({
      id: k,
      meta: map.get(k)?.[0]?.categoryMeta,
      items: map.get(k) ?? [],
    }));
  }, [rows]);

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-lg font-semibold tracking-tight">Providers</h1>
      {groups.map((g) => (
        <section key={g.id} className="space-y-2">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground">
              {g.meta?.name ?? g.id}
            </h2>
            {g.meta?.description ? (
              <p className="text-[11px] text-muted-foreground">{g.meta.description}</p>
            ) : null}
          </div>
          <div className="divide-y rounded-lg border border-border bg-card">
            {g.items.map((p) => (
              <div key={p.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    <code className="text-[11px] text-muted-foreground">{p.id}</code>
                    <span className="text-[11px] text-muted-foreground">v{p.version}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{p.description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {p.capabilities.map((c) => (
                    <Badge key={c} variant="secondary">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
