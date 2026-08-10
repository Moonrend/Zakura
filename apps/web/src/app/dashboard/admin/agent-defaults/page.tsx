"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type AgentDefaults = {
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  searchEngine: string | null;
  fetchBackend: string | null;
  autoManagedServices: string[];
};

type ManagedService = {
  key: string;
  name: string;
  description: string;
  mode: string;
  healthStatus: string;
  mapsTo?: { kind: string; id: string };
};

type WebCatalog = {
  webSearch: { engines: Array<{ id: string; name: string }> };
  webFetch: { backends: Array<{ id: string; name: string }> };
};

/** SaaS-only — stripped from OSS builds. */
export default function AdminAgentDefaultsPage() {
  const [defaults, setDefaults] = useState<AgentDefaults | null>(null);
  const [managedServices, setManagedServices] = useState<ManagedService[]>([]);
  const [catalog, setCatalog] = useState<WebCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, managed, cat] = await Promise.all([
          api<AgentDefaults>("/api/admin/agent-defaults"),
          api<{ services: ManagedService[] }>("/api/platform-services"),
          api<WebCatalog>("/api/capabilities"),
        ]);
        if (cancelled) return;
        setDefaults(d);
        setManagedServices(managed.services.filter((s) => s.mode !== "disabled"));
        setCatalog(cat);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!defaults) return;
    setSaving(true);
    try {
      setDefaults(
        await api<AgentDefaults>("/api/admin/agent-defaults", {
          method: "PUT",
          json: defaults,
        }),
      );
      toast.success("Agent 默认配置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** 每种能力最多选一个平台托管服务 */
  function setAutoService(kind: "search-engine" | "fetch-backend", next: string) {
    setDefaults((current) => {
      if (!current) return current;
      const without = current.autoManagedServices.filter((key) => {
        const svc = managedServices.find((s) => s.key === key);
        return svc?.mapsTo?.kind !== kind;
      });
      return {
        ...current,
        autoManagedServices: next ? [...without, next] : without,
      };
    });
  }

  function autoServiceFor(kind: "search-engine" | "fetch-backend"): string {
    return (
      defaults?.autoManagedServices.find((key) => {
        const svc = managedServices.find((s) => s.key === key);
        return svc?.mapsTo?.kind === kind;
      }) ?? ""
    );
  }

  if (loading || !defaults) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Agent 默认网页工具"
        description="新建 Agent 和未单独覆盖的 Agent 会跟随这里的设置。平台托管服务只对租户提供使用能力，连接地址和凭据不会下发。"
      />

      <SettingsSection title="默认开关">
        <div className="divide-y">
          <SettingsField label="默认启用网页搜索">
            <Switch
              checked={defaults.webSearchEnabled}
              onCheckedChange={(v) =>
                setDefaults((d) => d && { ...d, webSearchEnabled: v })
              }
            />
          </SettingsField>
          <SettingsField label="默认启用网页抓取">
            <Switch
              checked={defaults.webFetchEnabled}
              onCheckedChange={(v) => setDefaults((d) => d && { ...d, webFetchEnabled: v })}
            />
          </SettingsField>
        </div>

        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="platform-default-search">默认搜索引擎</Label>
            <select
              id="platform-default-search"
              value={defaults.searchEngine ?? ""}
              onChange={(e) =>
                setDefaults((d) => d && { ...d, searchEngine: e.target.value || null })
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">跟随网页配置</option>
              {(catalog?.webSearch.engines ?? []).map((item) => {
                const isAuto = managedServices.some(
                  (s) =>
                    s.mapsTo?.kind === "search-engine" &&
                    s.mapsTo.id === item.id &&
                    defaults.autoManagedServices.includes(s.key),
                );
                return (
                  <option key={item.id} value={item.id}>
                    {isAuto ? "Zakura 自动" : item.name}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-default-fetch">默认抓取后端</Label>
            <select
              id="platform-default-fetch"
              value={defaults.fetchBackend ?? ""}
              onChange={(e) =>
                setDefaults((d) => d && { ...d, fetchBackend: e.target.value || null })
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">跟随网页配置</option>
              {(catalog?.webFetch.backends ?? []).map((item) => {
                const isAuto = managedServices.some(
                  (s) =>
                    s.mapsTo?.kind === "fetch-backend" &&
                    s.mapsTo.id === item.id &&
                    defaults.autoManagedServices.includes(s.key),
                );
                return (
                  <option key={item.id} value={item.id}>
                    {isAuto ? "Zakura 自动" : item.name}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="平台默认自托管服务（Zakura 自动）"
        description="选中的服务会作为租户网页配置里的「Zakura 自动」选项；连接地址与凭据不会下发。每种能力最多选一个。"
      >
        {managedServices.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="platform-auto-search">默认搜索（平台托管）</Label>
              <select
                id="platform-auto-search"
                value={autoServiceFor("search-engine")}
                onChange={(e) => setAutoService("search-engine", e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">不提供</option>
                {managedServices
                  .filter((s) => s.mapsTo?.kind === "search-engine")
                  .map((service) => (
                    <option key={service.key} value={service.key}>
                      {service.name}
                      {service.healthStatus === "healthy" ? " · 健康" : ""}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-auto-fetch">默认抓取（平台托管）</Label>
              <select
                id="platform-auto-fetch"
                value={autoServiceFor("fetch-backend")}
                onChange={(e) => setAutoService("fetch-backend", e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">不提供</option>
                {managedServices
                  .filter((s) => s.mapsTo?.kind === "fetch-backend")
                  .map((service) => (
                    <option key={service.key} value={service.key}>
                      {service.name}
                      {service.healthStatus === "healthy" ? " · 健康" : ""}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            尚未启用任何平台自托管服务。请先在「自托管服务」中部署或接入，再在此设为平台默认。
          </p>
        )}
      </SettingsSection>

      <div>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存默认配置"}
        </Button>
      </div>
    </div>
  );
}
