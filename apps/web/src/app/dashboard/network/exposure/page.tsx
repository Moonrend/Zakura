"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Star } from "lucide-react";
import {
  createCloudflareNamedTunnel,
  fetchProviders,
  patchProvider,
  testProvider,
  type TunnelProviderSettingDto,
} from "@/lib/network";
import { SettingsHeader, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";

function ProviderCard({
  provider,
  onChange,
}: {
  provider: TunnelProviderSettingDto;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [server, setServer] = useState(String(provider.config.server ?? ""));
  const [frpToken, setFrpToken] = useState("");
  const [cfApiToken, setCfApiToken] = useState("");
  const [cfAccountId, setCfAccountId] = useState(String(provider.config.accountId ?? ""));
  const [tunnelName, setTunnelName] = useState("");

  async function toggleEnabled(enabled: boolean) {
    setBusy(true);
    try {
      await patchProvider(provider.provider, { enabled });
      toast.success(enabled ? "已启用" : "已禁用");
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setDefault() {
    setBusy(true);
    try {
      await patchProvider(provider.provider, { isDefault: true });
      toast.success("已设为默认");
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(config: Record<string, unknown>) {
    setBusy(true);
    try {
      await patchProvider(provider.provider, { config, enabled: true });
      toast.success("已保存");
      setToken("");
      setFrpToken("");
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    try {
      const res = await testProvider(provider.provider);
      if (res.ok) {
        toast.success(res.publicUrl ? `${res.message} · ${res.publicUrl}` : res.message);
      } else {
        toast.error(res.message);
      }
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{provider.meta.name}</span>
            {provider.isDefault ? (
              <Badge variant="default">
                <Star className="size-3" />
                默认
              </Badge>
            ) : null}
            <Badge variant={provider.enabled ? "default" : "secondary"}>
              {provider.enabled ? "已启用" : "未启用"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{provider.meta.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={provider.enabled}
            disabled={busy}
            onCheckedChange={(v) => void toggleEnabled(Boolean(v))}
          />
        </div>
      </div>

      {provider.provider === "cloudflare-named" ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            需 Cloudflare API Token（Tunnel Edit）或已有 Tunnel Token
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label>Account ID</Label>
              <Input
                className="w-48 font-mono text-xs"
                placeholder="账号 ID"
                value={cfAccountId}
                onChange={(e) => setCfAccountId(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>API Token</Label>
              <Input
                className="w-56 font-mono text-xs"
                type="password"
                placeholder={provider.config.apiToken ? "••••••••" : ""}
                value={cfApiToken}
                onChange={(e) => setCfApiToken(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={busy || (!cfApiToken.trim() && !cfAccountId.trim())}
              onClick={() =>
                void saveConfig({
                  accountId: cfAccountId.trim() || undefined,
                  ...(cfApiToken.trim() ? { apiToken: cfApiToken.trim() } : {}),
                })
              }
            >
              保存 API 凭证
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label>新建隧道名称（可选）</Label>
              <Input
                className="w-48 font-mono text-xs"
                placeholder="zakura-named"
                value={tunnelName}
                onChange={(e) => setTunnelName(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  // Persist credentials first if user typed them
                  if (cfApiToken.trim() || cfAccountId.trim()) {
                    await patchProvider(provider.provider, {
                      config: {
                        accountId: cfAccountId.trim() || undefined,
                        ...(cfApiToken.trim() ? { apiToken: cfApiToken.trim() } : {}),
                      },
                      enabled: true,
                    });
                    setCfApiToken("");
                  }
                  const res = await createCloudflareNamedTunnel(tunnelName || undefined);
                  toast.success(`已创建隧道 ${res.tunnelName}`);
                  setTunnelName("");
                  await onChange();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              用 API 创建 Named Tunnel
            </Button>
          </div>
          {Boolean(provider.config.tunnelId || provider.config.tunnelName) ? (
            <p className="text-xs text-muted-foreground">
              当前隧道：{String(provider.config.tunnelName ?? "")}{" "}
              <span className="font-mono">{String(provider.config.tunnelId ?? "")}</span>
              {provider.config.tunnelToken ? " · Token 已保存" : ""}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label>Tunnel Token（或手动粘贴）</Label>
              <Input
                className="w-64 font-mono text-xs"
                placeholder={provider.config.tunnelToken ? "••••••••" : "eyJ..."}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={busy || !token.trim()}
              onClick={() => void saveConfig({ tunnelToken: token })}
            >
              保存 Token
            </Button>
          </div>
        </div>
      ) : null}

      {provider.provider === "ngrok" ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Authtoken</Label>
            <Input
              className="w-64 font-mono text-xs"
              placeholder={provider.hasConfig ? "••••••••" : ""}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !token.trim()}
            onClick={() => void saveConfig({ authtoken: token })}
          >
            保存
          </Button>
        </div>
      ) : null}

      {provider.provider === "frp" ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Server</Label>
            <Input
              className="w-48 font-mono text-xs"
              placeholder="host:7000"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Token</Label>
            <Input
              className="w-40 font-mono text-xs"
              placeholder={provider.hasConfig ? "••••••••" : ""}
              value={frpToken}
              onChange={(e) => setFrpToken(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !server.trim()}
            onClick={() =>
              void saveConfig({
                server,
                ...(frpToken.trim() ? { token: frpToken } : {}),
              })
            }
          >
            保存
          </Button>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!provider.isDefault ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void setDefault()}>
            设为默认
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void runTest()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          测试连接
        </Button>
        {provider.lastError ? (
          <span className="text-xs text-destructive">{provider.lastError}</span>
        ) : provider.lastTestOk ? (
          <span className="text-xs text-muted-foreground">最近测试通过</span>
        ) : null}
      </div>
    </SettingsSection>
  );
}

export default function NetworkExposureProvidersPage() {
  const [providers, setProviders] = useState<TunnelProviderSettingDto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchProviders();
      setProviders(res.providers);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-5">
        <SettingsHeader title="端口暴露" />
        <PageLoading />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader title="端口暴露 Provider" />
      <p className="text-sm text-muted-foreground">一键暴露 workspace 端口</p>
      <div className="space-y-3">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} onChange={load} />
        ))}
      </div>
    </div>
  );
}
