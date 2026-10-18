"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConnectorOauthForm, type ConnectorOauthField } from "@/components/connections/connector-oauth-form";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import { listConnections, removeConnection, type InstalledConnection } from "@/lib/connections";

export type ConnectorView = {
  id: string;
  ref: string;
  name: string;
  description?: string | null;
  status: string;
  ready: boolean;
  enabled: boolean;
  lockedByPlatform?: boolean;
  auth: {
    kind: "none" | "oauth2" | "oauth2_dynamic" | "token" | "custom";
    profile: string;
    profileLabel?: string;
    fields: ConnectorOauthField[];
    settings: ConnectorOauthField[];
    docsUrl?: string;
  };
  profile: { key: string; label: string; shared: boolean; connectorRefs: string[]; configuredFields: string[]; enabled: boolean };
  configuredFields: string[];
  configuredSettings?: string[];
  authorized?: boolean;
  installations?: Array<{ id: string; spaceId: string; connectorRef: string; enabled: boolean; updatedAt: string }>;
  docsUrl?: string;
  package: { slug: string; name: string; icon?: string | null; accent?: string | null; homepage?: string | null };
  capabilities: Array<{ id: string; kind: string; ref: string; name: string; description?: string | null; config: Record<string, unknown>; installed?: boolean }>;
};

export function ConnectorConfigSheet({ connectors, redirectUri, open, onOpenChange, onChanged }: {
  connectors: ConnectorView[];
  redirectUri: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [activeRef, setActiveRef] = useState("");
  const connector = connectors.find((item) => item.ref === activeRef) ?? connectors[0];
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [installed, setInstalled] = useState<InstalledConnection[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState("");

  async function refresh() {
    const rows = await listConnections(spaceId || undefined);
    setInstalled(rows);
  }
  useEffect(() => { setActiveRef(connectors[0]?.ref ?? ""); setDraft({}); setSettings({}); }, [connectors]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError("");
    void fetchSpaces().then((rows) => { if (!cancelled) setSpaces(rows); }).catch((error) => { if (!cancelled) setLoadError(String(error)); });
    void listConnections(spaceId || undefined).then((rows) => { if (!cancelled) setInstalled(rows); }).catch((error) => { if (!cancelled) setLoadError(String(error)); });
    return () => { cancelled = true; };
  }, [open, spaceId]);
  useEffect(() => { setSettings({}); }, [spaceId, activeRef]);

  async function saveProfile() {
    if (!connector) return;
    setSaving(true);
    try {
      await api(`/api/connectors/profiles/${encodeURIComponent(connector.auth.profile)}`, {
        method: "PUT", json: { label: connector.profile.label, kind: connector.auth.kind, enabled, config: draft },
      });
      setDraft({});
      toast.success("租户认证档案已保存");
      onChanged();
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function install() {
    if (!connector || !spaceId) return;
    setSaving(true);
    try {
      const existing = installed.find((row) => row.spaceId === spaceId && row.providerId === connector.ref && row.status !== "conflict");
      if (!existing) await api(`/api/connectors/${encodeURIComponent(connector.ref)}/install`, {
        method: "POST", json: { spaceId, profileKey: connector.auth.profile, enabled: true, config: {} },
      });
      if (Object.keys(settings).length) await api(`/api/connectors/${encodeURIComponent(connector.ref)}/settings?spaceId=${encodeURIComponent(spaceId)}`, { method: "PUT", json: settings });
      setSettings({});
      await refresh();
      onChanged();
      toast.success("已保存到 Space");
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function authorize() {
    if (!connector || !spaceId) return;
    setSaving(true);
    try {
      const result = await api<{ authorizeUrl: string }>(`/api/connectors/${encodeURIComponent(connector.ref)}/oauth/start`, {
        method: "POST", json: { spaceId, profileKey: connector.auth.profile, redirectURI: redirectUri },
      });
      window.location.assign(result.authorizeUrl);
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function remove(row: InstalledConnection) {
    if (!window.confirm("从这个 Space 卸载连接器？租户认证档案会保留。")) return;
    setSaving(true);
    try { await removeConnection(row.id); await refresh(); onChanged(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  const rows = installed.filter((row) => row.providerId === connector?.ref);
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader>
        <SheetTitle>{connector?.name ?? "连接器"}</SheetTitle>
        <SheetDescription>{connector?.description ?? "连接器安装和设置属于 Space，Agent 只负责回复与行为路由。"}</SheetDescription>
      </SheetHeader>
      {connector ? <div className="space-y-6 px-4 pb-6">
        {loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : null}
        {connectors.length > 1 ? <select aria-label="连接器" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={connector.ref} onChange={(event) => setActiveRef(event.target.value)}>{connectors.map((item) => <option key={item.ref} value={item.ref}>{item.name}</option>)}</select> : null}
        {connector.auth.kind !== "none" ? <ConnectorOauthForm
          title="租户认证档案"
          description="认证档案仍由租户管理，供各 Space 引用。保存将替换档案内容；未填写的旧字段不会合并。"
          fields={connector.auth.fields}
          configuredFields={connector.configuredFields}
          draft={draft} onDraftChange={setDraft}
          enabled={enabled} onEnabledChange={setEnabled}
          redirectUri={redirectUri}
          canManage={!connector.lockedByPlatform} saving={saving} onSave={() => void saveProfile()}
        /> : null}
        <section className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="connector-space">安装到 Space</Label>
            <select id="connector-space" value={spaceId} onChange={(event) => setSpaceId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">选择 Space</option>
              {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </select>
            {!spaces.length && !loadError ? <p className="text-xs text-muted-foreground">先创建 Space，即使还没有 Agent 也可以安装连接器。</p> : null}
          </div>
          {connector.auth.settings.length ? <ConnectorOauthForm title="Space 设置" description="只修改所选 Space；保存会替换该 Space 的设置。" fields={connector.auth.settings} configuredFields={[]} draft={settings} onDraftChange={setSettings} enabled onEnabledChange={() => undefined} canManage={Boolean(spaceId)} saving={saving} onSave={() => void install()} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={saving || !spaceId} onClick={() => void install()}>{saving ? <Loader2 className="animate-spin" /> : null}保存到 Space</Button>
            {connector.auth.kind.startsWith("oauth") ? <Button variant="outline" disabled={saving || !spaceId} onClick={() => void authorize()}>授权租户档案</Button> : null}
          </div>
        </section>
        {rows.length ? <section className="divide-y divide-border border-y border-border">{rows.map((row) => <div key={row.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0 text-sm"><p>{spaces.find((space) => space.id === row.spaceId)?.name ?? row.spaceId}</p><p className="text-xs text-muted-foreground">{row.status === "conflict" ? `旧配置冲突 · ${row.legacyAgentId ?? ""}，请显式配置此 Space；旧配置保留，不会自动合并。` : row.status === "disabled" ? "已停用" : "已安装"}</p></div>{row.status !== "conflict" ? <Button size="icon" variant="ghost" aria-label="卸载" disabled={saving} onClick={() => void remove(row)}><Trash2 /></Button> : null}</div>)}</section> : null}
        {connector.auth.docsUrl ? <a href={connector.auth.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">厂商文档<ExternalLink className="size-3" /></a> : null}
      </div> : null}
    </SheetContent>
  </Sheet>;
}
