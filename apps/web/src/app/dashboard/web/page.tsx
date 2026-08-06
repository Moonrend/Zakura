"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  Plus,
  Save,
  Trash2,
  Zap,
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

type PlatformDefaults = {
  autoManagedServices: string[];
  multiTenant: boolean;
};

type FlatRow = {
  kind: "search" | "fetch";
  serviceId: string;
  serviceName: string;
  slot: SlotPublic;
  meta: EngineMeta | BackendMeta;
  platform?: ManagedHint;
};

type PickerItem =
  | {
      type: "zakura-auto";
      kind: "search" | "fetch";
      serviceId: string;
      platform: ManagedHint;
    }
  | {
      type: "provider";
      kind: "search" | "fetch";
      meta: EngineMeta | BackendMeta;
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

const ZAKURA_AUTO_NAME = "Zakura 自动";

function platformLabel(slot: SlotPublic) {
  if (!slot.usePlatform) return null;
  return slot.label?.trim() || ZAKURA_AUTO_NAME;
}

/** Platform-only credential slots surface as「Zakura 自动」, never jina/firecrawl names. */
function isZakuraAutoOnly(slots: SlotPublic[] | undefined): boolean {
  const list = slots ?? [];
  return list.length > 0 && list.every((s) => s.usePlatform);
}

function serviceDisplayName(
  metaName: string,
  slots: SlotPublic[] | undefined,
): string {
  return isZakuraAutoOnly(slots) ? ZAKURA_AUTO_NAME : metaName;
}

/* ── page ──────────────────────────────────────────────── */

export default function WebPage() {
  const [engines, setEngines] = useState<EngineMeta[]>([]);
  const [backends, setBackends] = useState<BackendMeta[]>([]);
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ engines: {} });
  const [fetchConfig, setFetchConfig] = useState<FetchConfig>({ backends: {} });
  const [managed, setManaged] = useState<ManagedHint[]>([]);
  const [platformDefaults, setPlatformDefaults] = useState<PlatformDefaults | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<"search" | "fetch">("search");
  const [editRow, setEditRow] = useState<FlatRow | null>(null);

  const multiTenant = platformDefaults?.multiTenant === true;

  const load = useCallback(async () => {
    try {
      const res = await api<{
        webSearch: { engines: EngineMeta[]; config: SearchConfig };
        webFetch: { backends: BackendMeta[]; config: FetchConfig };
        platformServices?: ManagedHint[];
        platformDefaults?: PlatformDefaults;
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
      setPlatformDefaults(res.platformDefaults ?? null);
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
          serviceName: slot.usePlatform ? ZAKURA_AUTO_NAME : meta.name,
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
          serviceName: slot.usePlatform ? ZAKURA_AUTO_NAME : meta.name,
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
    opts: { usePlatform?: boolean; openEditor?: boolean; label?: string },
  ) {
    const meta =
      kind === "search"
        ? engines.find((e) => e.id === serviceId)
        : backends.find((b) => b.id === serviceId);
    if (!meta) return;

    const slot: SlotPublic = {
      id: newId(),
      label: opts.usePlatform ? opts.label ?? "Zakura 自动" : undefined,
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

    if (opts.openEditor !== false) {
      setEditRow({
        kind,
        serviceId,
        serviceName: opts.usePlatform ? "Zakura 自动" : meta.name,
        slot,
        meta,
        platform: managedFor(
          managed,
          kind === "search" ? "search-engine" : "fetch-backend",
          serviceId,
        ),
      });
    } else {
      toast.success(
        opts.usePlatform ? "已添加 Zakura 自动" : `已添加 ${meta.name}`,
      );
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

  /** Picker catalog:「Zakura 自动」(platform defaults) + regular providers; no action buttons. */
  const pickerCatalog = useMemo((): PickerItem[] => {
    const mapKind = pickerKind === "search" ? "search-engine" : "fetch-backend";
    // SaaS: API already filters to admin-selected defaults (at most one per kind).
    // OSS: expose each running managed service as Zakura 自动 when multiple exist.
    const platformForKind = managed.filter((m) => m.mapsTo.kind === mapKind);
    const items: PickerItem[] = platformForKind.map((platform) => ({
      type: "zakura-auto" as const,
      kind: pickerKind,
      serviceId: platform.mapsTo.id,
      platform,
    }));

    const list =
      pickerKind === "search"
        ? engines.map((meta) => ({ type: "provider" as const, kind: "search" as const, meta }))
        : backends.map((meta) => ({ type: "provider" as const, kind: "fetch" as const, meta }));

    list.sort((a, b) => a.meta.name.localeCompare(b.meta.name, "zh"));
    items.push(...list);
    return items;
  }, [pickerKind, engines, backends, managed]);

  function onPickItem(item: PickerItem) {
    if (item.type === "zakura-auto") {
      // Add platform slot and open a short confirmation dialog (no keys needed).
      addSlot(item.kind, item.serviceId, {
        usePlatform: true,
        openEditor: true,
        label: "Zakura 自动",
      });
      return;
    }
    // Always open the detail dialog so users see description + API key link.
    addSlot(item.kind, item.meta.id, { usePlatform: false, openEditor: true });
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="网页"
        description="搜索与抓取；多凭据时轮询调用"
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
            defaultItems={searchEnabledIds.map((id) => {
              const metaName = engines.find((e) => e.id === id)?.name ?? id;
              return {
                value: id,
                label: serviceDisplayName(
                  metaName,
                  searchConfig.engines[id]?.slots,
                ),
              };
            })}
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
            defaultItems={fetchEnabledIds.map((id) => {
              const metaName = backends.find((b) => b.id === id)?.name ?? id;
              return {
                value: id,
                label: serviceDisplayName(
                  metaName,
                  fetchConfig.backends[id]?.slots,
                ),
              };
            })}
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

      {/* ── Add service picker (click row → detail dialog; no action buttons) ── */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              添加{pickerKind === "search" ? "搜索" : "抓取"}提供商
            </DialogTitle>
            <DialogDescription>选择一项以继续</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
            {pickerCatalog.map((item) => {
              if (item.type === "zakura-auto") {
                const multiAuto =
                  pickerCatalog.filter((i) => i.type === "zakura-auto").length > 1;
                return (
                  <button
                    key={`zakura-auto:${item.platform.key}`}
                    type="button"
                    onClick={() => onPickItem(item)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left",
                      "transition-colors hover:bg-muted/50",
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Zap className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {multiAuto && !multiTenant
                          ? `Zakura 自动 · ${item.platform.name}`
                          : "Zakura 自动"}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        使用平台托管，无需配置
                      </span>
                    </span>
                  </button>
                );
              }
              return (
                <button
                  key={item.meta.id}
                  type="button"
                  onClick={() => onPickItem(item)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5 text-left",
                    "transition-colors hover:bg-muted/50",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.meta.name}</span>
                    {item.meta.requiresApiKey ? (
                      <span className="block text-[11px] text-muted-foreground">需 API Key</span>
                    ) : item.meta.requiresBaseUrl ? (
                      <span className="block text-[11px] text-muted-foreground">需自建端点</span>
                    ) : (
                      <span className="block text-[11px] text-muted-foreground">点击配置</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit / configure slot ── */}
      <Dialog open={Boolean(editRow)} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-md">
          {editRow ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editRow.slot.usePlatform
                    ? "Zakura 自动"
                    : editRow.serviceName}
                  {!editRow.slot.usePlatform && editRow.slot.label
                    ? ` · ${editRow.slot.label}`
                    : ""}
                </DialogTitle>
                <DialogDescription>
                  {editRow.slot.usePlatform
                    ? "Zakura"
                    : editRow.meta.description}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {!editRow.slot.usePlatform ? (
                  <div className="flex flex-wrap gap-3 text-[12px]">
                    {editRow.meta.apiKeyUrl ? (
                      <a
                        href={editRow.meta.apiKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        获取 API Key
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {editRow.meta.docsUrl ? (
                      <a
                        href={editRow.meta.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
                      >
                        文档
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : null}

                {editRow.slot.usePlatform ? (
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    我们希望为您提供优质的体验。
                  </p>
                ) : (
                  <>
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

                    {editRow.meta.requiresBaseUrl ||
                    editRow.serviceId === "searxng" ||
                    editRow.serviceId === "sogou" ||
                    editRow.serviceId === "yandex" ||
                    editRow.serviceId === "firecrawl" ||
                    editRow.serviceId === "crawl4ai" ||
                    editRow.serviceId === "jina-reader" ||
                    editRow.serviceId === "cloudflare-markdown" ? (
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
                  </>
                )}

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
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择默认">
                {(value) => {
                  const v = Array.isArray(value) ? value[0] : value;
                  if (v == null || v === "") return null;
                  return (
                    defaultItems.find((it) => it.value === v)?.label ?? String(v)
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {defaultItems.map((it) => (
                <SelectItem key={it.value} value={it.value} label={it.label}>
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
            const platLabel = platformLabel(row.slot);
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
                    {platLabel ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {platLabel === "Zakura 自动" ? "平台" : platLabel}
                      </Badge>
                    ) : null}
                    {multi ? (
                      <Badge variant="outline" className="text-[10px]">
                        轮询
                      </Badge>
                    ) : null}
                    {!row.slot.usePlatform && row.slot.label ? (
                      <span className="text-[11px] text-muted-foreground">
                        {row.slot.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {row.slot.usePlatform
                      ? "由 Zakura 托管"
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
