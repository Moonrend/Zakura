"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import { SettingsHeader, SettingsSection, SettingsField } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";

type Domain = {
  id: string;
  domain: string;
  joinMode: string;
  verified: boolean;
  txtHost: string;
  txtToken: string;
};

type Sso = {
  enabled: boolean;
  protocol: "oidc" | "saml";
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  jitEnabled: boolean;
  enforceSso: boolean;
  defaultRole: string;
  acsUrl: string;
  redirectUri: string;
  spEntityId: string;
  idpSsoUrl?: string;
  metadataUrl?: string;
};

export default function IdentitySettingsPage() {
  const me = useMe();
  const admin = me.role === "owner" || me.role === "admin";
  const [domains, setDomains] = useState<Domain[]>([]);
  const [sso, setSso] = useState<Sso | null>(null);
  const [scim, setScim] = useState<{ endpoint: string; tokens: Array<{ id: string; name: string; tokenPrefix: string }> } | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [idpCert, setIdpCert] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!admin) return;
    const [d, s, c] = await Promise.all([
      api<{ domains: Domain[] }>("/api/tenant/identity/domains"),
      api<{ sso: Sso }>("/api/tenant/identity/sso"),
      api<{ endpoint: string; tokens: Array<{ id: string; name: string; tokenPrefix: string }> }>("/api/tenant/identity/scim"),
    ]);
    setDomains(d.domains);
    setSso(s.sso);
    setScim(c);
  }, [admin]);

  useEffect(() => {
    void load().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  if (!admin) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="身份" description="仅团队管理员可配置域名、SSO 与 SCIM。" />
      </div>
    );
  }
  if (!sso || !scim) return <PageLoading />;

  return (
    <div className="space-y-5">
      <SettingsHeader title="身份" description="验证域名、企业 SSO 与目录同步" />

      <SettingsSection title="验证域名">
        <div className="space-y-3">
          {domains.map((row) => (
            <div key={row.id} className="space-y-1 rounded-lg border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{row.domain}</span>
                <span className="text-xs text-muted-foreground">{row.verified ? "已验证" : "未验证"} · {row.joinMode}</span>
              </div>
              <p className="text-xs text-muted-foreground">TXT {row.txtHost} = {row.txtToken}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={async () => {
                  try {
                    await api(`/api/tenant/identity/domains/${row.id}/verify`, { method: "POST" });
                    await load();
                    toast.success("域名已验证");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                  }
                }}>验证 DNS</Button>
                <Button size="sm" variant="outline" onClick={async () => {
                  const next = row.joinMode === "auto_join" ? "sso_required" : row.joinMode === "sso_required" ? "invite_only" : "auto_join";
                  await api(`/api/tenant/identity/domains/${row.id}`, { method: "PATCH", json: { joinMode: next } });
                  await load();
                }}>加入方式：{row.joinMode}</Button>
                <Button size="sm" variant="ghost" onClick={async () => {
                  await api(`/api/tenant/identity/domains/${row.id}`, { method: "DELETE" });
                  await load();
                }}>删除</Button>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Input placeholder="example.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
            <Button size="sm" onClick={async () => {
              try {
                await api("/api/tenant/identity/domains", { method: "POST", json: { domain: newDomain } });
                setNewDomain("");
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}>添加</Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="SSO">
        <SettingsField label="启用">
          <Switch checked={sso.enabled} onCheckedChange={(enabled) => setSso({ ...sso, enabled })} />
        </SettingsField>
        <SettingsField label="协议">
          <div className="flex gap-2">
            <Button size="sm" variant={sso.protocol === "oidc" ? "default" : "outline"} onClick={() => setSso({ ...sso, protocol: "oidc" })}>OIDC</Button>
            <Button size="sm" variant={sso.protocol === "saml" ? "default" : "outline"} onClick={() => setSso({ ...sso, protocol: "saml" })}>SAML</Button>
          </div>
        </SettingsField>
        {sso.protocol === "oidc" ? (
          <>
            <SettingsField label="Issuer"><Input value={sso.issuer} onChange={(e) => setSso({ ...sso, issuer: e.target.value })} /></SettingsField>
            <SettingsField label="Client ID"><Input value={sso.clientId} onChange={(e) => setSso({ ...sso, clientId: e.target.value })} /></SettingsField>
            <SettingsField label="Client Secret"><Input type="password" placeholder={sso.hasClientSecret ? "已配置" : ""} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></SettingsField>
            <p className="text-xs text-muted-foreground">回调 {sso.redirectUri}</p>
          </>
        ) : (
          <>
            <SettingsField label="IdP SSO URL"><Input value={sso.idpSsoUrl ?? ""} onChange={(e) => setSso({ ...sso, idpSsoUrl: e.target.value })} /></SettingsField>
            <SettingsField label="IdP 证书"><Input value={idpCert} onChange={(e) => setIdpCert(e.target.value)} placeholder="已配置则留空" /></SettingsField>
            <p className="text-xs text-muted-foreground">ACS {sso.acsUrl}<br />Entity ID {sso.spEntityId}</p>
          </>
        )}
        <SettingsField label="自动开通">
          <Switch checked={sso.jitEnabled} onCheckedChange={(jitEnabled) => setSso({ ...sso, jitEnabled })} />
        </SettingsField>
        <SettingsField label="强制 SSO">
          <Switch checked={sso.enforceSso} onCheckedChange={(enforceSso) => setSso({ ...sso, enforceSso })} />
        </SettingsField>
        <SettingsField label="默认角色">
          <div className="flex gap-2">
            <Button size="sm" variant={sso.defaultRole === "member" ? "default" : "outline"} onClick={() => setSso({ ...sso, defaultRole: "member" })}>成员</Button>
            <Button size="sm" variant={sso.defaultRole === "admin" ? "default" : "outline"} onClick={() => setSso({ ...sso, defaultRole: "admin" })}>管理员</Button>
          </div>
        </SettingsField>
        {sso.protocol === "saml" && sso.metadataUrl ? (
          <p className="text-xs text-muted-foreground">
            <a href={sso.metadataUrl} className="underline" target="_blank" rel="noreferrer">下载 SP metadata</a>
          </p>
        ) : null}
        <Button size="sm" onClick={async () => {
          try {
            const res = await api<{ sso: Sso }>("/api/tenant/identity/sso", {
              method: "PUT",
              json: {
                ...sso,
                clientSecret: clientSecret || undefined,
                idpCertificate: idpCert || undefined,
              },
            });
            setSso(res.sso);
            setClientSecret("");
            setIdpCert("");
            toast.success("已保存");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          }
        }}>保存 SSO</Button>
      </SettingsSection>

      <SettingsSection title="SCIM">
        <p className="text-xs text-muted-foreground">端点 {scim.endpoint}</p>
        {newToken ? <code className="block break-all rounded border p-2 text-xs">{newToken}</code> : null}
        <div className="space-y-2">
          {scim.tokens.map((row) => (
            <div key={row.id} className="flex items-center justify-between text-sm">
              <span>{row.name} · {row.tokenPrefix}…</span>
              <Button size="sm" variant="ghost" onClick={async () => {
                await api(`/api/tenant/identity/scim/tokens/${row.id}`, { method: "DELETE" });
                await load();
              }}>吊销</Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={async () => {
          const res = await api<{ token: string }>("/api/tenant/identity/scim/tokens", { method: "POST", json: { name: "SCIM" } });
          setNewToken(res.token);
          await load();
          toast.success("请立即复制 token，只显示一次");
        }}>生成 token</Button>
      </SettingsSection>
    </div>
  );
}
