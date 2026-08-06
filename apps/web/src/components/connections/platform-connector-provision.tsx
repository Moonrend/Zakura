"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  ConnectorOauthForm,
  type ConnectorOauthField,
} from "@/components/connections/connector-oauth-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { SettingsSection } from "@/components/settings-shell";
import { api } from "@/lib/api";

type AuthKind = "none" | "oauth2" | "oauth2_dynamic" | "token" | "custom";

type Profile = {
  key: string;
  label: string;
  kind: AuthKind;
  enabled: boolean;
  custom: boolean;
  fields: ConnectorOauthField[];
  configuredFields: string[];
  docsUrl?: string;
  connectorRefs: string[];
};

const KIND_LABELS: Record<AuthKind, string> = {
  none: "无需认证",
  oauth2: "OAuth 2.0",
  oauth2_dynamic: "动态 OAuth",
  token: "静态令牌",
  custom: "自定义",
};

/** SaaS 平台管理员：管理命名认证档案，并向引用它的连接器提供整站配置。 */
export function PlatformConnectorProvisionPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [redirectUri, setRedirectUri] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<AuthKind>("oauth2");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (selectKey?: string) => {
    setLoading(true);
    try {
      const [profileRes, connectorRes] = await Promise.all([
        api<{ profiles: Profile[] }>("/api/connectors/profiles?scope=platform"),
        api<{ redirectUri: string }>("/api/connectors?scope=platform"),
      ]);
      setProfiles(profileRes.profiles);
      setRedirectUri(connectorRes.redirectUri);
      if (selectKey) setOpenKey(selectKey);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const value = q.trim().toLowerCase();
    if (!value) return profiles;
    return profiles.filter((profile) =>
      [profile.key, profile.label, profile.kind, ...profile.connectorRefs]
        .some((item) => item.toLowerCase().includes(value)),
    );
  }, [profiles, q]);

  const selected = profiles.find((profile) => profile.key === openKey) ?? null;

  useEffect(() => {
    setDraft({});
    setEnabled(selected?.enabled ?? false);
  }, [selected]);

  async function createProfile() {
    const key = newKey.trim();
    if (!key) {
      toast.error("请输入认证档案名称");
      return;
    }
    setCreating(true);
    try {
      await api(`/api/connectors/profiles/${encodeURIComponent(key)}?scope=platform`, {
        method: "PUT",
        json: { kind: newKind, label: newLabel.trim() || key, enabled: false, values: {} },
      });
      setNewKey("");
      setNewLabel("");
      toast.success("认证档案已创建");
      await load(key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await api<{ profile: Profile }>(
        `/api/connectors/profiles/${encodeURIComponent(selected.key)}?scope=platform`,
        { method: "PUT", json: { enabled, values: draft } },
      );
      setProfiles((current) =>
        current.map((profile) => (profile.key === selected.key ? result.profile : profile)),
      );
      setDraft({});
      toast.success(`${selected.label} 已保存`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="连接器认证档案">
      <div id="connector-oauth" className="scroll-mt-20 space-y-5">
        <div className="flex items-start gap-2 border-b border-border pb-4 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            在这里预配命名认证档案。连接器通过目录声明引用档案；启用整站档案后，团队侧会自动复用且不能覆盖同名配置。
          </p>
        </div>

        <div className="space-y-3 border-b border-border pb-5">
          <div className="flex items-center gap-2">
            <Plus className="size-4" />
            <h3 className="text-sm font-medium">新建档案</h3>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
            <Input
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder="档案名称"
              autoComplete="off"
            />
            <Input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="显示名称（可选）"
              autoComplete="off"
            />
            <select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value as AuthKind)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <Button onClick={() => void createProfile()} disabled={creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              创建
            </Button>
          </div>
        </div>

        <SearchField value={q} onValueChange={setQ} placeholder="搜索档案或连接器引用" />

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {filtered.map((profile) => {
              const open = openKey === profile.key;
              return (
                <div key={profile.key}>
                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : profile.key)}
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{profile.label}</span>
                        <code className="text-[10px] text-muted-foreground">{profile.key}</code>
                        <Badge variant={profile.enabled ? "secondary" : "outline"}>
                          {profile.enabled ? "已启用" : "未启用"}
                        </Badge>
                        {profile.custom ? <Badge variant="outline">手动</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {KIND_LABELS[profile.kind]} ·{" "}
                        {profile.connectorRefs.length
                          ? `被 ${profile.connectorRefs.length} 个连接器引用`
                          : "当前没有目录引用"}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{open ? "收起" : "配置"}</span>
                  </button>
                  {open && selected?.key === profile.key ? (
                    <div className="border-t border-border py-4">
                      <ConnectorOauthForm
                        title={`${profile.label} · 整站配置`}
                        description="引用此档案的连接器共用这套认证。"
                        fields={profile.fields}
                        configuredFields={profile.configuredFields}
                        draft={draft}
                        onDraftChange={setDraft}
                        enabled={enabled}
                        onEnabledChange={setEnabled}
                        redirectUri={
                          profile.kind === "oauth2" || profile.kind === "oauth2_dynamic"
                            ? redirectUri
                            : undefined
                        }
                        docsUrl={profile.docsUrl}
                        canManage
                        saving={saving}
                        onSave={() => void save()}
                        enableLabel="启用整站档案"
                        enableHint="团队侧将锁定同名档案"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!filtered.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的认证档案</p>
            ) : null}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
