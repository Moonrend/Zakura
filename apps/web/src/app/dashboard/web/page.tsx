"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type EngineMeta = {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
  extraFields?: Array<{ key: string; title: string; secret?: boolean; placeholder?: string }>;
};

type EngineCfg = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, string>;
};

type SearchPayload = {
  instance: { id: string; status: string; healthStatus: string; lastError?: string | null; slug: string };
  engines: EngineMeta[];
  config: {
    defaultEngine?: string;
    engines?: Record<string, EngineCfg>;
  };
};

type BackendMeta = {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  requiresBaseUrl?: boolean;
};

type BackendCfg = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
};

type FetchPayload = {
  instance: { id: string; status: string; healthStatus: string; lastError?: string | null; slug: string };
  backends: BackendMeta[];
  config: {
    defaultBackend?: string;
    backends?: Record<string, BackendCfg>;
  };
};

export default function WebPage() {
  const [searchData, setSearchData] = useState<SearchPayload | null>(null);
  const [searchConfig, setSearchConfig] = useState<SearchPayload["config"]>({ engines: {} });
  const [searchSaving, setSearchSaving] = useState(false);

  const [fetchData, setFetchData] = useState<FetchPayload | null>(null);
  const [fetchConfig, setFetchConfig] = useState<FetchPayload["config"]>({ backends: {} });
  const [fetchSaving, setFetchSaving] = useState(false);

  const loadSearch = useCallback(async () => {
    try {
      const res = await api<{ webSearch: SearchPayload; webFetch: FetchPayload }>(
        "/api/capabilities",
      );
      setSearchData(res.webSearch);
      setSearchConfig(res.webSearch.config ?? { engines: {} });
      setFetchData(res.webFetch);
      setFetchConfig(res.webFetch.config ?? { backends: {} });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadFetch = useCallback(async () => {
    try {
      const res = await api<FetchPayload>("/api/capabilities/web-fetch");
      setFetchData(res);
      setFetchConfig(res.config ?? { backends: {} });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadSearch();
  }, [loadSearch]);

  function patchEngine(id: string, patch: Partial<EngineCfg>) {
    setSearchConfig((c) => ({
      ...c,
      engines: {
        ...(c.engines ?? {}),
        [id]: { ...(c.engines?.[id] ?? {}), ...patch },
      },
    }));
  }

  function patchExtra(id: string, key: string, value: string) {
    const prev = searchConfig.engines?.[id] ?? {};
    patchEngine(id, {
      extra: { ...(prev.extra ?? {}), [key]: value },
    });
  }

  async function saveSearch() {
    setSearchSaving(true);
    try {
      await api("/api/capabilities/web-search", { method: "PUT", json: searchConfig });
      toast.success("搜索配置已保存");
      await loadSearch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchSaving(false);
    }
  }

  function patchBackend(id: string, patch: Partial<BackendCfg>) {
    setFetchConfig((c) => ({
      ...c,
      backends: {
        ...(c.backends ?? {}),
        [id]: { ...(c.backends?.[id] ?? {}), ...patch },
      },
    }));
  }

  async function saveFetch() {
    setFetchSaving(true);
    try {
      await api("/api/capabilities/web-fetch", { method: "PUT", json: fetchConfig });
      toast.success("抓取配置已保存");
      await loadFetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchSaving(false);
    }
  }

  const searchEnabledIds = Object.entries(searchConfig.engines ?? {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);

  const fetchEnabledIds = Object.entries(fetchConfig.backends ?? {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);

  return (
    <div className="space-y-5">
      <SettingsHeader title="网页" />

      <SettingsSection title="搜索">
        {!searchData ? (
          <div className="text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="space-y-3">
            {searchData.instance.lastError ? (
              <p className="text-xs text-destructive">{searchData.instance.lastError}</p>
            ) : null}

            <div className="max-w-xs space-y-1.5">
              <Label>默认引擎</Label>
              <Select
                value={searchConfig.defaultEngine ?? searchEnabledIds[0] ?? ""}
                onValueChange={(v) => {
                  if (v != null) setSearchConfig((c) => ({ ...c, defaultEngine: v }));
                }}
                items={(searchEnabledIds.length
                  ? searchEnabledIds
                  : searchData.engines.map((e) => e.id)
                ).map((id) => ({
                  value: id,
                  label: searchData.engines.find((e) => e.id === id)?.name ?? id,
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择默认引擎" />
                </SelectTrigger>
                <SelectContent>
                  {(searchEnabledIds.length
                    ? searchEnabledIds
                    : searchData.engines.map((e) => e.id)
                  ).map((id) => (
                    <SelectItem key={id} value={id}>
                      {searchData.engines.find((e) => e.id === id)?.name ?? id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="divide-y rounded-lg border border-border bg-background">
              {searchData.engines.map((engine) => {
                const cfg = searchConfig.engines?.[engine.id] ?? {};
                const on = Boolean(cfg.enabled);
                return (
                  <div key={engine.id} className="space-y-2 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{engine.name}</span>
                          <code className="text-[11px] text-muted-foreground">{engine.id}</code>
                          {engine.requiresApiKey ? (
                            <Badge variant="outline">API Key</Badge>
                          ) : null}
                        </div>
                      </div>
                      <Switch
                        checked={on}
                        onCheckedChange={(v) => patchEngine(engine.id, { enabled: v })}
                      />
                    </div>
                    {on && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {engine.requiresApiKey || cfg.apiKey !== undefined ? (
                          <div className="space-y-1">
                            <Label>API Key</Label>
                            <Input
                              type="password"
                              value={cfg.apiKey ?? ""}
                              placeholder={engine.requiresApiKey ? "必填" : "可选"}
                              onChange={(e) => patchEngine(engine.id, { apiKey: e.target.value })}
                            />
                          </div>
                        ) : null}
                        {engine.requiresBaseUrl ||
                        engine.id === "searxng" ||
                        engine.id === "sogou" ||
                        engine.id === "yandex" ? (
                          <div className="space-y-1">
                            <Label>Base URL</Label>
                            <Input
                              value={cfg.baseUrl ?? ""}
                              placeholder={
                                engine.id === "searxng"
                                  ? "https://searx.example.com"
                                  : "https://..."
                              }
                              onChange={(e) => patchEngine(engine.id, { baseUrl: e.target.value })}
                            />
                          </div>
                        ) : null}
                        {(engine.extraFields ?? []).map((f) => (
                          <div key={f.key} className="space-y-1">
                            <Label>{f.title}</Label>
                            <Input
                              type={f.secret ? "password" : "text"}
                              value={cfg.extra?.[f.key] ?? ""}
                              placeholder={f.placeholder}
                              onChange={(e) => patchExtra(engine.id, f.key, e.target.value)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <Button size="sm" disabled={searchSaving} onClick={() => void saveSearch()}>
                <Save />
                保存
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="抓取">
        {!fetchData ? (
          <div className="text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="space-y-3">
            <div className="max-w-xs space-y-1.5">
              <Label>默认后端</Label>
              <Select
                value={fetchConfig.defaultBackend ?? fetchEnabledIds[0] ?? ""}
                onValueChange={(v) => {
                  if (v != null) setFetchConfig((c) => ({ ...c, defaultBackend: v }));
                }}
                items={(fetchEnabledIds.length
                  ? fetchEnabledIds
                  : fetchData.backends.map((b) => b.id)
                ).map((id) => ({
                  value: id,
                  label: fetchData.backends.find((b) => b.id === id)?.name ?? id,
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择默认后端" />
                </SelectTrigger>
                <SelectContent>
                  {(fetchEnabledIds.length
                    ? fetchEnabledIds
                    : fetchData.backends.map((b) => b.id)
                  ).map((id) => (
                    <SelectItem key={id} value={id}>
                      {fetchData.backends.find((b) => b.id === id)?.name ?? id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="divide-y rounded-lg border border-border bg-background">
              {fetchData.backends.map((backend) => {
                const cfg = fetchConfig.backends?.[backend.id] ?? {};
                const on = Boolean(cfg.enabled);
                return (
                  <div key={backend.id} className="space-y-2 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{backend.name}</span>
                          <code className="text-[11px] text-muted-foreground">{backend.id}</code>
                        </div>
                      </div>
                      <Switch
                        checked={on}
                        onCheckedChange={(v) => patchBackend(backend.id, { enabled: v })}
                      />
                    </div>
                    {on && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label>API Key（可选）</Label>
                          <Input
                            type="password"
                            value={cfg.apiKey ?? ""}
                            onChange={(e) => patchBackend(backend.id, { apiKey: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>Base URL（可选）</Label>
                          <Input
                            value={cfg.baseUrl ?? ""}
                            placeholder={
                              backend.id === "cloudflare-markdown"
                                ? "默认 https://markdown.new"
                                : "可选自定义"
                            }
                            onChange={(e) => patchBackend(backend.id, { baseUrl: e.target.value })}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <Button size="sm" disabled={fetchSaving} onClick={() => void saveFetch()}>
                <Save />
                保存
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
