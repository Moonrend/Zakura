"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Shield } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import { Badge } from "@/components/ui/badge";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ConnectorOauthForm,
  type ConnectorOauthField,
} from "@/components/connections/connector-oauth-form";
import { SettingsSection } from "@/components/settings-shell";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ConnectorRow = {
  id: string;
  ref: string;
  name: string;
  description: string;
  fields: ConnectorOauthField[];
  docsUrl?: string;
  enabled: boolean;
  ready: boolean;
  configuredFields: string[];
  package: { slug: string; name: string; icon?: string | null; accent?: string | null };
};

/** 超管：整站预配连接器 OAuth 客户端；启用后各团队不可自行覆盖 */
export function PlatformConnectorProvisionPanel() {
  const [items, setItems] = useState<ConnectorRow[]>([]);
  const [redirectUri, setRedirectUri] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ connectors: ConnectorRow[]; redirectUri: string }>(
        "/api/connectors?scope=platform",
      );
      setItems(res.connectors);
      setRedirectUri(res.redirectUri);
      setOpenId((current) =>
        current && res.connectors.some((c) => c.id === current)
          ? current
          : null,
      );
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
    if (!value) return items;
    return items.filter((item) =>
      [item.name, item.description, item.package.name, item.ref]
        .filter(Boolean)
        .some((t) => String(t).toLowerCase().includes(value)),
    );
  }, [items, q]);

  const selected = items.find((item) => item.id === openId) ?? null;

  useEffect(() => {
    setDraft({});
    setEnabled(selected?.enabled ?? false);
  }, [selected]);

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await api<{ connector: ConnectorRow }>(
        `/api/connectors/${selected.id}/credentials?scope=platform`,
        { method: "PUT", json: { enabled, values: draft } },
      );
      setItems((current) =>
        current.map((item) => (item.id === selected.id ? result.connector : item)),
      );
      setDraft({});
      toast.success(`${result.connector.name} 整站预配已保存`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="连接器 OAuth 预配">
      <div id="connector-oauth" className="scroll-mt-20 space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          <Shield className="mt-0.5 size-3.5 shrink-0" />
          <p>
            在此为 Google、Microsoft、GitHub 等自调 API 连接器配置整站 OAuth 客户端。启用后，各团队连接器页将锁定凭据，用户只需授权。仅预配、无 API 工具的项不会出现在此列表。
          </p>
        </div>

        <SearchField value={q} onValueChange={setQ} placeholder="搜索连接器" />

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((item) => {
              const open = openId === item.id;
              return (
                <div
                  key={item.id}
                  className="overflow-hidden rounded-xl border border-border bg-card"
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : item.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30"
                  >
                    <BrandIcon
                      brandId={item.package.slug}
                      name={item.name}
                      accent={item.package.accent}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{item.name}</span>
                        {item.ready ? (
                          <Badge variant="secondary" className="text-[10px]">
                            已预配
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            未配置
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                  {open && selected?.id === item.id ? (
                    <div className="border-t border-border p-4">
                      <ConnectorOauthForm
                        title={`${item.name} · 整站客户端`}
                        description="启用后所有团队共用此客户端，团队侧不可覆盖。"
                        fields={item.fields}
                        configuredFields={item.configuredFields}
                        draft={draft}
                        onDraftChange={setDraft}
                        enabled={enabled}
                        onEnabledChange={setEnabled}
                        redirectUri={redirectUri}
                        docsUrl={item.docsUrl}
                        canManage
                        saving={saving}
                        onSave={() => void save()}
                        enableLabel="启用整站预配"
                        enableHint="锁定各团队的 OAuth 客户端配置"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!filtered.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    加载中…
                  </span>
                ) : (
                  "没有匹配的连接器"
                )}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
