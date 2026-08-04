"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  Plus,
  Save,
  Server,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/* ── types ─────────────────────────────────────────────── */

type ExtraField = {
  key: string;
  title: string;
  secret?: boolean;
  placeholder?: string;
};

type EngineMeta = {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
  extraFields?: ExtraField[];
  docsUrl?: string;
  apiKeyUrl?: string;
  platformServiceKey?: string;
};

type BackendMeta = {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
  docsUrl?: string;
  apiKeyUrl?: string;
  platformServiceKey?: string;
};

type SlotPublic = {
  id: string;
  label?: string;
  usePlatform?: boolean;
  hasApiKey: boolean;
  baseUrl?: string;
  extra?: Record<string, string>;
  /** Local draft only — never echoed from server */
  apiKey?: string;
};

type EngineCfgPublic = {
  enabled: boolean;
  slots: SlotPublic[];
};

type BackendCfgPublic = {
  enabled: boolean;
  slots: SlotPublic[];
};

type SearchConfig = {
  defaultEngine?: string;
  engines: Record<string, EngineCfgPublic>;
};

type FetchConfig = {
  defaultBackend?: string;
  backends: Record<string, BackendCfgPublic>;
};

type ManagedHint = {
  key: string;
  name: string;
  mode: string;
  healthStatus: string;
  mapsTo: { kind: string; id: string };
  endpointUrl?: string | null;
};

type FlatRow = {
  kind: "search" | "fetch";
  serviceId: string;
  serviceName: string;
  slot: SlotPublic;
  meta: EngineMeta | BackendMeta;
  platform?: ManagedHint;
};

/* ── helpers ───────────────────────────────────────────── */

function newId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function managedFor(
  managed: ManagedHint[],
  kind: "search-engine" | "fetch-backend",
  id: string,
) {
  return managed.find((m) => m.mapsTo.kind === kind && m.mapsTo.id === id);
}

/* ── page ──────────────────────────────────────────────── */

export default function WebPage() {
  const [engines, setEngines] = useState<EngineMeta[]>([]);
  const [backends, setBackends] = useState<BackendMeta[]>([]);
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ engines: {} });
  const [fetchConfig, setFetchConfig] = useState<FetchConfig>({ backends: {} });
  const [managed, setManaged] = useState<ManagedHint[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<"search" | "fetch">("search");
  const [editRow, setEditRow] = useState<FlatRow | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{
        webSearch: { engines: EngineMeta[]; config: SearchConfig };
        webFetch: { backends: BackendMeta[]; config: FetchConfig };
        platformServices?: ManagedHint[];
      }>("/api/capabilities");
      setEngines(res.webSearch.engines);
      setBackends(res.webFetch.backends);
      setSearchConfig({
        defaultEngine: res.webSearch.config.defaultEngine,
        engines: res.webSearch.config.engines ?? {},
      });
      setFetchConfig({
        defaultBackend: res.webFetch.config.defaultBackend,
        backends: res.webFetch.config.backends ?? {},
      });
      setManaged(res.platformServices ?? []);
      setLoaded(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const searchRows = useMemo((): FlatRow[] => {
    const rows: FlatRow[] = [];
    for (const meta of engines) {
      const cfg = searchConfig.engines[meta.id];
      if (!cfg?.enabled) continue;
      const plat = managedFor(managed, "search-engine", meta.id);
      for (const slot of cfg.slots ?? []) {
        rows.push({
          kind: "search",
          serviceId: meta.id,
          serviceName: meta.name,
          slot,
          meta,
          platform: plat,
        });
      }
    }
    return rows;
  }, [engines, searchConfig, managed]);

  const fetchRows = useMemo((): FlatRow[] => {
    const rows: FlatRow[] = [];
    for (const meta of backends) {
      const cfg = fetchConfig.backends[meta.id];
      if (!cfg?.enabled) continue;
      const plat = managedFor(managed, "fetch-backend", meta.id);
      for (const slot of cfg.slots ?? []) {
        rows.push({
          kind: "fetch",
          serviceId: meta.id,
          serviceName: meta.name,
          slot,
          meta,
          platform: plat,
        });
      }
    }
    return rows;
  }, [backends, fetchConfig, managed]);

  const searchEnabledIds = useMemo(
    () =>
      Object.entries(searchConfig.engines)
        .filter(([, v]) => v?.enabled)
        .map(([k]) => k),
    [searchConfig],
  );

  const fetchEnabledIds = useMemo(
    () =>
      Object.entries(fetchConfig.backends)
        .filter(([, v]) => v?.enabled)
        .map(([k]) => k),
    [fetchConfig],
  );

  function openPicker(kind: "search" | "fetch") {
    setPickerKind(kind);
    setPickerOpen(true);
  }

  function addSlot(
    kind: "search" | "fetch",
    serviceId: string,
    opts: { usePlatform?: boolean },
  ) {
    const meta =
      kind === "search"
        ? engines.find((e) => e.id === serviceId)
        : backends.find((b) => b.id === serviceId);
    if (!meta) return;

    const slot: SlotPublic = {
      id: newId(),
      label: opts.usePlatform ? "平台托管" : undefined,
      usePlatform: opts.usePlatform || undefined,
      hasApiKey: false,
      apiKey: "",
      baseUrl: "",
      extra: {},
    };

    if (kind === "search") {
      setSearchConfig((c) => {
        const prev = c.engines[serviceId];
        const slots = [...(prev?.slots ?? []), slot];
        return {
          ...c,
          engines: {
            ...c.engines,
            [serviceId]: { enabled: true, slots },
          },
          defaultEngine: c.defaultEngine ?? serviceId,
        };
      });
    } else {
      setFetchConfig((c) => {
        const prev = c.backends[serviceId];
        const slots = [...(prev?.slots ?? []), slot];
        return {
          ...c,
          backends: {
            ...c.backends,
            [serviceId]: { enabled: true, slots },
          },
          defaultBackend: c.defaultBackend ?? serviceId,
        };
      });
    }

    setPickerOpen(false);
    // open editor for non-platform free engines that need keys
    if (!opts.usePlatform && (meta.requiresApiKey || meta.requiresBaseUrl)) {
      setEditRow({
        kind,
        serviceId,
        serviceName: meta.name,
        slot,
        meta,
        platform: managedFor(
          managed,
          kind === "search" ? "search-engine" : "fetch-backend",
          serviceId,
        ),
      });
    } else {
      toast.success(`已添加 ${meta.name}${opts.usePlatform ? "（平台）" : ""}`);
    }
  }

  function removeSlot(kind: "search" | "fetch", serviceId: string, slotId: string) {
    if (kind === "search") {
      setSearchConfig((c) => {
        const prev = c.engines[serviceId];
        if (!prev) return c;
        const slots = (prev.slots ?? []).filter((s) => s.id !== slotId);
        const engines = { ...c.engines };
        if (slots.length === 0) delete engines[serviceId];
        else engines[serviceId] = { enabled: true, slots };
        let defaultEngine = c.defaultEngine;
        if (defaultEngine === serviceId && !engines[serviceId]) {
          defaultEngine = Object.keys(engines)[0];
        }
        return { ...c, engines, defaultEngine };
      });
    } else {
      setFetchConfig((c) => {
        const prev = c.backends[serviceId];
        if (!prev) return c;
        const slots = (prev.slots ?? []).filter((s) => s.id !== slotId);
        const backends = { ...c.backends };
        if (slots.length === 0) delete backends[serviceId];
        else backends[serviceId] = { enabled: true, slots };
        let defaultBackend = c.defaultBackend;
        if (defaultBackend === serviceId && !backends[serviceId]) {
          defaultBackend = Object.keys(backends)[0];
        }
        return { ...c, backends, defaultBackend };
      });
    }
  }

  function patchSlot(
    kind: "search" | "fetch",
    serviceId: string,
    slotId: string,
    patch: Partial<SlotPublic>,
  ) {
    if (kind === "search") {
      setSearchConfig((c) => {
        const prev = c.engines[serviceId];
        if (!prev) return c;
        return {
          ...c,
          engines: {
            ...c.engines,
            [serviceId]: {
              enabled: true,
              slots: (prev.slots ?? []).map((s) =>
                s.id === slotId ? { ...s, ...patch } : s,
              ),
            },
          },
        };
      });
    } else {
      setFetchConfig((c) => {
        const prev = c.backends[serviceId];
        if (!prev) return c;
        return {
          ...c,
          backends: {
            ...c.backends,
            [serviceId]: {
              enabled: true,
              slots: (prev.slots ?? []).map((s) =>
                s.id === slotId ? { ...s, ...patch } : s,
              ),
            },
          },
        };
      });
    }
    if (editRow?.slot.id === slotId) {
      setEditRow((r) => (r ? { ...r, slot: { ...r.slot, ...patch } } : r));
    }
  }

  async function saveAll() {
    setSaving(true);
    try {
      // Send slots as-is; empty apiKey means keep previous on server
      await Promise.all([
        api("/api/capabilities/web-search", {
          method: "PUT",
          json: searchConfig,
        }),
        api("/api/capabilities/web-fetch", {
          method: "PUT",
          json: fetchConfig,
        }),
      ]);
      toast.success("已保存");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /* catalog for picker: platform first */
  const pickerCatalog = useMemo(() => {
    if (pickerKind === "search") {
      const list = engines.map((e) => {
        const plat = managedFor(managed, "search-engine", e.id);
        return { meta: e, platform: plat, kind: "search" as const };
      });
      list.sort((a, b) => {
        const ap = a.platform ? 0 : 1;
        const bp = b.platform ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.meta.name.localeCompare(b.meta.name, "zh");
      });
      return list;
    }
    const list = backends.map((b) => {
      const plat = managedFor(managed, "fetch-backend", b.id);
      return { meta: b, platform: plat, kind: "fetch" as const };
    });
    list.sort((a, b) => {
      const ap = a.platform ? 0 : 1;
      const bp = b.platform ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.meta.name.localeCompare(b.meta.name, "zh");
    });
    return list;
  }, [pickerKind, engines, backends, managed]);

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="网页"
        description="按团队隔离的搜索 / 抓取配置。同一服务可添加多个凭据，调用时轮询。"
        actions={
          <Button size="sm" disabled={saving || !loaded} onClick={() => void saveAll()}>
            <Save className="size-3.5" />
            保存
          </Button>
        }
      />

      {!loaded ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : (
        <>
          <ServiceSection
            title="搜索"
            defaultLabel="默认引擎"
            defaultValue={searchConfig.defaultEngine ?? searchEnabledIds[0] ?? ""}
            defaultItems={searchEnabledIds.map((id) => ({
              value: id,
              label: engines.find((e) => e.id === id)?.name ?? id,
            }))}
            onDefaultChange={(v) =>
              setSearchConfig((c) => ({ ...c, defaultEngine: v }))
            }
            rows={searchRows}
            onAdd={() => openPicker("search")}
            onEdit={setEditRow}
            onRemove={(row) => removeSlot("search", row.serviceId, row.slot.id)}
          />

          <ServiceSection
            title="抓取"
            defaultLabel="默认后端"
            defaultValue={fetchConfig.defaultBackend ?? fetchEnabledIds[0] ?? ""}
            defaultItems={fetchEnabledIds.map((id) => ({
              value: id,
              label: backends.find((b) => b.id === id)?.name ?? id,
            }))}
            onDefaultChange={(v) =>
              setFetchConfig((c) => ({ ...c, defaultBackend: v }))
            }
            rows={fetchRows}
            onAdd={() => openPicker("fetch")}
            onEdit={setEditRow}
            onRemove={(row) => removeSlot("fetch", row.serviceId, row.slot.id)}
          />
        </>
      )}

      {/* ── Add service picker ── */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              添加{pickerKind === "search" ? "搜索" : "抓取"}服务
            </DialogTitle>
            <DialogDescription>
              平台已托管的排在最前。可重复添加同一服务以实现多 Key 轮询。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
            {pickerCatalog.map(({ meta, platform }) => (
              <div
                key={meta.id}
                className="rounded-lg border border-border px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{meta.name}</span>
                      {platform ? (
                        <Badge variant="secondary" className="text-[10px]">
                          <Server className="mr-0.5 size-2.5" />
                          平台
                          {platform.healthStatus === "healthy" ? " · 健康" : ""}
                        </Badge>
                      ) : null}
                      {meta.requiresApiKey ? (
                        <Badge variant="outline" className="text-[10px]">
                          API Key
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                      {meta.description}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                      {meta.apiKeyUrl ? (
                        <a
                          href={meta.apiKeyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          获取 API Key
                          <ExternalLink className="size-2.5" />
                        </a>
                      ) : null}
                      {meta.docsUrl ? (
                        <a
                          href={meta.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-muted-foreground hover:underline"
                        >
                          文档
                          <ExternalLink className="size-2.5" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {platform ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        addSlot(pickerKind, meta.id, { usePlatform: true })
                      }
                    >
                      使用平台托管
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={platform ? "outline" : "default"}
                    onClick={() =>
                      addSlot(pickerKind, meta.id, { usePlatform: false })
                    }
                  >
                    {platform ? "添加自有配置" : "添加"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit slot ── */}
      <Dialog open={Boolean(editRow)} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-md">
          {editRow ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editRow.serviceName}
                  {editRow.slot.label ? ` · ${editRow.slot.label}` : ""}
                </DialogTitle>
                <DialogDescription>
                  凭据仅保存在当前团队配置中，不会跨团队共享。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">备注（可选）</Label>
                  <Input
                    value={editRow.slot.label ?? ""}
                    placeholder="如：主账号 / 备用"
                    onChange={(e) =>
                      patchSlot(editRow.kind, editRow.serviceId, editRow.slot.id, {
                        label: e.target.value,
                      })
                    }
                  />
                </div>

                {editRow.slot.usePlatform ? (
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    使用自托管服务端点，无需填写 Base URL。
                  </p>
                ) : null}

                {(editRow.meta.requiresApiKey ||
                  editRow.slot.hasApiKey ||
                  editRow.slot.apiKey !== undefined) && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">API Key</Label>
                      {editRow.meta.apiKeyUrl ? (
                        <a
                          href={editRow.meta.apiKeyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"
                        >
                          获取
                          <ExternalLink className="size-2.5" />
                        </a>
                      ) : null}
                    </div>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={editRow.slot.apiKey ?? ""}
                      placeholder={
                        editRow.slot.hasApiKey ? "•••• 留空不改" : "必填"
                      }
                      onChange={(e) =>
                        patchSlot(
                          editRow.kind,
                          editRow.serviceId,
                          editRow.slot.id,
                          { apiKey: e.target.value },
                        )
                      }
                    />
                  </div>
                )}

                {!editRow.slot.usePlatform &&
                (editRow.meta.requiresBaseUrl ||
                  editRow.serviceId === "searxng" ||
                  editRow.serviceId === "sogou" ||
                  editRow.serviceId === "yandex" ||
                  editRow.serviceId === "firecrawl" ||
                  editRow.serviceId === "crawl4ai" ||
                  editRow.serviceId === "jina-reader" ||
                  editRow.serviceId === "cloudflare-markdown") ? (
                  <div className="space-y-1">
                    <Label className="text-xs">Base URL</Label>
                    <Input
                      className="font-mono text-xs"
                      value={editRow.slot.baseUrl ?? ""}
                      placeholder={
                        editRow.serviceId === "jina-reader"
                          ? "默认 https://r.jina.ai"
                          : editRow.serviceId === "cloudflare-markdown"
                            ? "默认 https://markdown.new"
                            : "https://..."
                      }
                      onChange={(e) =>
                        patchSlot(
                          editRow.kind,
                          editRow.serviceId,
                          editRow.slot.id,
                          { baseUrl: e.target.value },
                        )
                      }
                    />
                  </div>
                ) : null}

                {editRow.kind === "search" &&
                  ((editRow.meta as EngineMeta).extraFields ?? []).map((f) => (
                    <div key={f.key} className="space-y-1">
                      <Label className="text-xs">{f.title}</Label>
                      <Input
                        type={f.secret ? "password" : "text"}
                        value={editRow.slot.extra?.[f.key] ?? ""}
                        placeholder={f.placeholder}
                        onChange={(e) =>
                          patchSlot(
                            editRow.kind,
                            editRow.serviceId,
                            editRow.slot.id,
                            {
                              extra: {
                                ...(editRow.slot.extra ?? {}),
                                [f.key]: e.target.value,
                              },
                            },
                          )
                        }
                      />
                    </div>
                  ))}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditRow(null)}
                  >
                    完成
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── section list ──────────────────────────────────────── */

function ServiceSection({
  title,
  defaultLabel,
  defaultValue,
  defaultItems,
  onDefaultChange,
  rows,
  onAdd,
  onEdit,
  onRemove,
}: {
  title: string;
  defaultLabel: string;
  defaultValue: string;
  defaultItems: { value: string; label: string }[];
  onDefaultChange: (v: string) => void;
  rows: FlatRow[];
  onAdd: () => void;
  onEdit: (row: FlatRow) => void;
  onRemove: (row: FlatRow) => void;
}) {
  // Count per service for "轮询" badge
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      m.set(r.serviceId, (m.get(r.serviceId) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  return (
    <SettingsSection
      title={title}
      action={
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Plus className="size-3.5" />
          添加
        </Button>
      }
    >
      {defaultItems.length > 0 ? (
        <div className="mb-3 max-w-xs space-y-1.5">
          <Label className="text-xs">{defaultLabel}</Label>
          <Select
            value={defaultValue}
            onValueChange={(v) => {
              if (v != null) onDefaultChange(v);
            }}
            items={defaultItems}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择默认" />
            </SelectTrigger>
            <SelectContent>
              {defaultItems.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border",
            "px-4 py-8 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/30",
          )}
        >
          <Plus className="size-5 opacity-60" />
          <span>点击添加{title}服务</span>
        </button>
      ) : (
        <div className="divide-y rounded-lg border border-border bg-background">
          {rows.map((row) => {
            const multi = (counts.get(row.serviceId) ?? 0) > 1;
            return (
              <div
                key={`${row.serviceId}:${row.slot.id}`}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onEdit(row)}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{row.serviceName}</span>
                    {row.slot.usePlatform ? (
                      <Badge variant="secondary" className="text-[10px]">
                        平台托管
                      </Badge>
                    ) : null}
                    {multi ? (
                      <Badge variant="outline" className="text-[10px]">
                        轮询
                      </Badge>
                    ) : null}
                    {row.slot.label ? (
                      <span className="text-[11px] text-muted-foreground">
                        {row.slot.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {row.slot.usePlatform
                      ? "使用平台托管端点"
                      : row.slot.baseUrl ||
                        (row.slot.hasApiKey ? "已配置 API Key" : "点击配置凭据")}
                  </p>
                </button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(row)}
                  aria-label="删除"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
