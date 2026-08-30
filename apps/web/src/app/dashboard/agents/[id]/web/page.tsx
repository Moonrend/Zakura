"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  fetchAgentProviders,
  saveAgentProviders,
  type AgentProviderOptions,
} from "@/lib/agents";
import {
  SettingsHeader,
  SettingsRow,
  SettingsSaveIndicator,
  SettingsSection,
} from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TENANT_DEFAULT = "__tenant__";

type WebState = {
  searchEnabled: boolean;
  searchEngine: string;
  fetchEnabled: boolean;
  fetchBackend: string;
};

export default function AgentWebPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [state, setState] = useState<WebState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchAgentProviders(id);
      setOpts(res);
      setState({
        searchEnabled: res.webSearch.agent.enabled,
        searchEngine: res.webSearch.agent.defaultEngine ?? TENANT_DEFAULT,
        fetchEnabled: res.webFetch.agent.enabled,
        fetchBackend: res.webFetch.agent.defaultBackend ?? TENANT_DEFAULT,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(
    async (patch: Partial<WebState>) => {
      const body: Parameters<typeof saveAgentProviders>[1] = {};
      if (patch.searchEnabled !== undefined || patch.searchEngine !== undefined) {
        body.webSearch = {
          ...(patch.searchEnabled !== undefined
            ? { enabled: patch.searchEnabled }
            : {}),
          ...(patch.searchEngine !== undefined
            ? {
                defaultEngine:
                  patch.searchEngine === TENANT_DEFAULT ? null : patch.searchEngine,
              }
            : {}),
        };
      }
      if (patch.fetchEnabled !== undefined || patch.fetchBackend !== undefined) {
        body.webFetch = {
          ...(patch.fetchEnabled !== undefined
            ? { enabled: patch.fetchEnabled }
            : {}),
          ...(patch.fetchBackend !== undefined
            ? {
                defaultBackend:
                  patch.fetchBackend === TENANT_DEFAULT ? null : patch.fetchBackend,
              }
            : {}),
        };
      }
      const res = await saveAgentProviders(id, body);
      setOpts(res.options);
    },
    [id],
  );

  const { status, error, saveNow } = useAutoSave(persist);

  function update<K extends keyof WebState>(key: K, value: WebState[K]) {
    setState((prev) => (prev ? { ...prev, [key]: value } : prev));
    saveNow({ [key]: value } as Partial<WebState>);
  }

  if (!opts || !state) {
    return <PageLoading />;
  }

  const engines = opts.webSearch.engines;
  const backends = opts.webFetch.backends;

  const searchDefaultLabel =
    opts.webSearch.tenantDefaultEngineName ??
    engines.find((e) => e.id === opts.webSearch.tenantDefaultEngine)?.name ??
    null;
  const fetchDefaultLabel =
    opts.webFetch.tenantDefaultBackendName ??
    backends.find((b) => b.id === opts.webFetch.tenantDefaultBackend)?.name ??
    null;

  const searchItems = [
    {
      value: TENANT_DEFAULT,
      label: searchDefaultLabel
        ? `跟随全局（${searchDefaultLabel}）`
        : "跟随全局",
    },
    ...engines.map((e) => ({ value: e.id, label: e.name })),
  ];
  const fetchItems = [
    {
      value: TENANT_DEFAULT,
      label: fetchDefaultLabel
        ? `跟随全局（${fetchDefaultLabel}）`
        : "跟随全局",
    },
    ...backends.map((b) => ({ value: b.id, label: b.name })),
  ];

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="网页"
        actions={<SettingsSaveIndicator status={status} error={error} />}
      />

      <SettingsSection title="搜索">
        <SettingsRow label="启用" htmlFor="web-search-on">
          <Switch
            id="web-search-on"
            checked={state.searchEnabled}
            onCheckedChange={(v) => update("searchEnabled", Boolean(v))}
          />
        </SettingsRow>
        <div
          className={
            state.searchEnabled
              ? "space-y-1.5 pt-1"
              : "pointer-events-none space-y-1.5 pt-1 opacity-50"
          }
        >
          <Label>默认引擎</Label>
          <Select
            value={state.searchEngine}
            onValueChange={(v) => {
              if (v != null) update("searchEngine", v);
            }}
            disabled={!engines.length}
            items={searchItems}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="选择引擎">
                {(value) => {
                  const v = Array.isArray(value) ? value[0] : value;
                  if (v == null || v === "") return null;
                  return (
                    searchItems.find((it) => it.value === v)?.label ?? String(v)
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {searchItems.map((it) => (
                <SelectItem key={it.value} value={it.value} label={it.label}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!engines.length ? (
            <p className="text-xs text-muted-foreground">
              全局未配置引擎。
              <Link href="/dashboard/web" className="ml-1 underline">
                去配置
              </Link>
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="抓取">
        <SettingsRow label="启用" htmlFor="web-fetch-on">
          <Switch
            id="web-fetch-on"
            checked={state.fetchEnabled}
            onCheckedChange={(v) => update("fetchEnabled", Boolean(v))}
          />
        </SettingsRow>
        <div
          className={
            state.fetchEnabled
              ? "space-y-1.5 pt-1"
              : "pointer-events-none space-y-1.5 pt-1 opacity-50"
          }
        >
          <Label>默认后端</Label>
          <Select
            value={state.fetchBackend}
            onValueChange={(v) => {
              if (v != null) update("fetchBackend", v);
            }}
            disabled={!backends.length}
            items={fetchItems}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="选择后端">
                {(value) => {
                  const v = Array.isArray(value) ? value[0] : value;
                  if (v == null || v === "") return null;
                  return (
                    fetchItems.find((it) => it.value === v)?.label ?? String(v)
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {fetchItems.map((it) => (
                <SelectItem key={it.value} value={it.value} label={it.label}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!backends.length ? (
            <p className="text-xs text-muted-foreground">
              全局未配置后端。
              <Link href="/dashboard/web" className="ml-1 underline">
                去配置
              </Link>
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}
