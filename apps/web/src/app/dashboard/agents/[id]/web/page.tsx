"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Save } from "lucide-react";
import {
  fetchAgentProviders,
  saveAgentProviders,
  type AgentProviderOptions,
} from "@/lib/agents";
import { SettingsField, SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TENANT_DEFAULT = "__tenant__";

export default function AgentWebPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [searchEngine, setSearchEngine] = useState(TENANT_DEFAULT);
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const [fetchBackend, setFetchBackend] = useState(TENANT_DEFAULT);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchAgentProviders(id);
      setOpts(res);
      setSearchEnabled(res.webSearch.agent.enabled);
      setSearchEngine(res.webSearch.agent.defaultEngine ?? TENANT_DEFAULT);
      setFetchEnabled(res.webFetch.agent.enabled);
      setFetchBackend(res.webFetch.agent.defaultBackend ?? TENANT_DEFAULT);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const res = await saveAgentProviders(id, {
        webSearch: {
          enabled: searchEnabled,
          defaultEngine: searchEngine === TENANT_DEFAULT ? null : searchEngine,
        },
        webFetch: {
          enabled: fetchEnabled,
          defaultBackend: fetchBackend === TENANT_DEFAULT ? null : fetchBackend,
        },
      });
      setOpts(res.options);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!opts) {
    return <div className="text-sm text-muted-foreground">…</div>;
  }

  const engines = opts.webSearch.engines;
  const backends = opts.webFetch.backends;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="网页"
        actions={
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            <Save />
            保存
          </Button>
        }
      />

      <SettingsSection title="搜索">
        <SettingsField label="启用">
          <Switch checked={searchEnabled} onCheckedChange={setSearchEnabled} />
        </SettingsField>

        <div
          className={
            searchEnabled ? "space-y-1.5" : "pointer-events-none space-y-1.5 opacity-50"
          }
        >
          <Label>默认引擎</Label>
          <Select
            value={searchEngine}
            onValueChange={(v) => {
              if (v != null) setSearchEngine(v);
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
        <SettingsField label="启用">
          <Switch checked={fetchEnabled} onCheckedChange={setFetchEnabled} />
        </SettingsField>

        <div
          className={
            fetchEnabled ? "space-y-1.5" : "pointer-events-none space-y-1.5 opacity-50"
          }
        >
          <Label>默认后端</Label>
          <Select
            value={fetchBackend}
            onValueChange={(v) => {
              if (v != null) setFetchBackend(v);
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
