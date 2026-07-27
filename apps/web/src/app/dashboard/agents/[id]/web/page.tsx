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
import { Skeleton } from "@/components/ui/skeleton";
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
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const engines = opts.webSearch.engines;
  const backends = opts.webFetch.backends;

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
            items={[
              {
                value: TENANT_DEFAULT,
                label: opts.webSearch.tenantDefaultEngine
                  ? `跟随全局（${opts.webSearch.tenantDefaultEngine}）`
                  : "跟随全局",
              },
              ...engines.map((e) => ({ value: e.id, label: e.name })),
            ]}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择引擎" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TENANT_DEFAULT}>
                跟随全局
                {opts.webSearch.tenantDefaultEngine
                  ? `（${opts.webSearch.tenantDefaultEngine}）`
                  : ""}
              </SelectItem>
              {engines.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
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
            items={[
              {
                value: TENANT_DEFAULT,
                label: opts.webFetch.tenantDefaultBackend
                  ? `跟随全局（${opts.webFetch.tenantDefaultBackend}）`
                  : "跟随全局",
              },
              ...backends.map((b) => ({ value: b.id, label: b.name })),
            ]}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择后端" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TENANT_DEFAULT}>
                跟随全局
                {opts.webFetch.tenantDefaultBackend
                  ? `（${opts.webFetch.tenantDefaultBackend}）`
                  : ""}
              </SelectItem>
              {backends.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
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
