"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BrandIcon } from "@/components/brand-icon";
import { useMe } from "@/components/me-context";
import { ConnectorOauthForm } from "@/components/connections/connector-oauth-form";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { installConnection } from "@/lib/connections";
import { installSkill } from "@/lib/skills";

type ConnectorField = {
  key: string;
  label: string;
  type: "text" | "secret" | "url" | "textarea";
  required?: boolean;
  placeholder?: string;
};

type ConnectorDetail = {
  id: string;
  ref: string;
  name: string;
  description: string;
  fields: ConnectorField[];
  docsUrl?: string;
  enabled: boolean;
  ready: boolean;
  configuredFields: string[];
  lockedByPlatform?: boolean;
  package: { slug: string; name: string; icon?: string | null; accent?: string | null };
};

type IntegrationPackage = {
  slug: string;
  name: string;
  description: string;
  icon?: string | null;
  accent?: string | null;
  homepage?: string | null;
  verified?: boolean;
  components: Array<{
    kind: string;
    ref: string;
    name: string;
    description?: string | null;
    installed?: boolean;
    config: Record<string, unknown>;
  }>;
};

function ConnectorDetailInner() {
  const me = useMe();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const slug = decodeURIComponent(params.id);

  const [pkg, setPkg] = useState<IntegrationPackage | null>(null);
  const [connector, setConnector] = useState<ConnectorDetail | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const canManageTenant = me.role === "owner" || me.role === "admin";
  const locked = !!connector?.lockedByPlatform;
  const canManage = !locked && canManageTenant;
  const canSeeAdmin = me.multiTenant === true && me.isPlatformAdmin === true;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pkgRes, creds] = await Promise.all([
        api<{ package: IntegrationPackage }>(
          `/api/integrations/packages/${encodeURIComponent(slug)}`,
        ),
        api<{ connectors: ConnectorDetail[]; redirectUri: string }>(
          "/api/connectors?scope=tenant",
        ),
      ]);
      setPkg(pkgRes.package);
      setRedirectUri(creds.redirectUri);
      const match =
        creds.connectors.find((c) => c.package.slug === slug) ??
        creds.connectors.find((c) => c.ref === slug) ??
        null;
      setConnector(match);
      setEnabled(match?.enabled ?? false);
      setDraft({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPkg(null);
      setConnector(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const tools = useMemo(
    () => (pkg?.components ?? []).filter((c) => c.kind === "tool"),
    [pkg],
  );
  const skills = useMemo(
    () => (pkg?.components ?? []).filter((c) => c.kind === "skill"),
    [pkg],
  );

  async function save() {
    if (!connector) return;
    setSaving(true);
    try {
      const result = await api<{ connector: ConnectorDetail }>(
        `/api/connectors/${connector.id}/credentials?scope=tenant`,
        { method: "PUT", json: { enabled, values: draft } },
      );
      setConnector(result.connector);
      setEnabled(result.connector.enabled);
      setDraft({});
      toast.success(`${result.connector.name} 凭据已保存`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function installTool(tool: IntegrationPackage["components"][number]) {
    const mcpUrl = String(tool.config.mcpUrl ?? "");
    if (!mcpUrl.startsWith("zakura://")) {
      toast.error("该工具缺少平台 mcpUrl");
      return;
    }
    setInstalling(tool.ref);
    try {
      const result = await installConnection({
        source: `zakura:${mcpUrl.slice("zakura://".length)}`,
      });
      toast.success(`${tool.name} 已安装`);
      await load();
      if (result.authRequired && result.instanceId) {
        router.push(`/dashboard/mcp/${result.instanceId}?oauth=1`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(null);
    }
  }

  async function installBuiltinSkill(skill: IntegrationPackage["components"][number]) {
    const source = String(skill.config.source ?? `builtin:${skill.ref}`);
    setInstalling(skill.ref);
    try {
      await installSkill({ source });
      toast.success(`${skill.name} 技能已安装`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (!pkg || !connector) {
    return (
      <div className="space-y-4">
        <Link
          href="/dashboard/connectors"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          返回连接器
        </Link>
        <p className="text-sm text-muted-foreground">未找到连接器 {slug}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/connectors"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        连接器
      </Link>

      <SettingsHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <BrandIcon
              brandId={pkg.slug}
              name={pkg.name}
              accent={pkg.accent}
              homepage={pkg.homepage}
              size="md"
            />
            {pkg.name}
          </span>
        }
        description={pkg.description}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">平台直连 API</Badge>
        {pkg.verified ? <Badge variant="secondary">官方</Badge> : null}
        {locked ? <Badge variant="outline">整站已预配</Badge> : null}
        {connector.ready ? (
          <Badge variant="secondary">OAuth 就绪</Badge>
        ) : (
          <Badge variant="outline">待配置 OAuth</Badge>
        )}
        {pkg.homepage ? (
          <a
            href={pkg.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            文档
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      <ol className="space-y-6">
        <li className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-muted-foreground">1</span>
            <h2 className="text-sm font-medium">配置 OAuth 客户端</h2>
          </div>
          {locked ? (
            <p className="text-xs text-muted-foreground">
              管理员已整站预配该 OAuth 客户端，可直接安装工具并完成用户授权。
              {canSeeAdmin ? (
                <>
                  {" "}
                  <Link
                    href="/dashboard/admin#connector-oauth"
                    className="text-foreground hover:underline"
                  >
                    在超管页管理
                  </Link>
                </>
              ) : null}
            </p>
          ) : (
            <div className="max-w-2xl">
              <ConnectorOauthForm
                description="在厂商控制台创建应用，填入下方回调 URI，再粘贴 Client ID / Secret。配置完成后即可安装产品工具。"
                fields={connector.fields}
                configuredFields={connector.configuredFields}
                draft={draft}
                onDraftChange={setDraft}
                enabled={enabled}
                onEnabledChange={setEnabled}
                redirectUri={redirectUri}
                docsUrl={connector.docsUrl}
                canManage={canManage}
                lockedHint="仅团队管理员可修改"
                saving={saving}
                onSave={() => void save()}
                enableLabel="启用"
                enableHint="使用当前团队的 OAuth 客户端"
              />
            </div>
          )}
        </li>

        <li className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-muted-foreground">2</span>
            <div>
              <h2 className="text-sm font-medium">安装产品工具并授权</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                平台代理对应 API；安装后跳转完成用户 OAuth 授权。
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {tools.map((tool) => (
              <div
                key={tool.ref}
                className="flex flex-col rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium">{tool.name}</h3>
                    {tool.description ? (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {tool.description}
                      </p>
                    ) : null}
                  </div>
                  {tool.installed ? (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      已装
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-4">
                  <Button
                    size="sm"
                    variant={tool.installed ? "outline" : "default"}
                    disabled={!!installing || !connector.ready}
                    onClick={() => void installTool(tool)}
                  >
                    {installing === tool.ref ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
                    {tool.installed ? "重新授权" : "安装并授权"}
                  </Button>
                  {!connector.ready && !locked ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      请先完成上一步 OAuth 配置
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </li>

        {skills.length ? (
          <li className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-muted-foreground">3</span>
              <div>
                <h2 className="text-sm font-medium">安装 Agent 技能（可选）</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  技能教 Agent 如何编排上方工具。
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {skills.map((skill) => (
                <div
                  key={skill.ref}
                  className="flex flex-col rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">{skill.name}</h3>
                      {skill.description ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {skill.description}
                        </p>
                      ) : null}
                    </div>
                    {skill.installed ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        已装
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-4">
                    <Button
                      size="sm"
                      variant={skill.installed ? "outline" : "default"}
                      disabled={!!installing}
                      onClick={() => void installBuiltinSkill(skill)}
                    >
                      {installing === skill.ref ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      {skill.installed ? "已安装" : "安装技能"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

export default function ConnectorDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
      <ConnectorDetailInner />
    </Suspense>
  );
}
