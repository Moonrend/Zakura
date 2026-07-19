"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ProvisionGuide = {
  projectId: string;
  oauthClientAutomation: "unsupported";
  limitation: string;
  redirectUri: string;
  consoleLinks: {
    enableApis: string;
    oauthConsent: string;
    createOauthClient: string;
    credentials: string;
  };
  requiredScopes: Array<{ product: string; scopes: string[] }>;
  gcloudScript: string;
  checklist?: string[];
  enabled?: string[];
  alreadyEnabled?: string[];
  failed?: Array<{ service: string; error: string }>;
};

type Props = {
  /** 供应完成后把 Client 写入本租户 Google OAuth App */
  onClientReady?: (client: { clientId: string; clientSecret: string }) => void;
  defaultScope?: "tenant" | "platform";
};

/**
 * Google Cloud 供应向导：
 * 1) 可选：用 Service Account 自动启用 MCP API
 * 2) 引导用户在 Console 创建 Web OAuth 客户端（Google 无公开 API）
 * 3) 粘贴 Client ID/Secret → 写入租户配置
 */
export function GoogleCloudProvisionPanel({
  onClientReady,
  defaultScope = "tenant",
}: Props) {
  const [projectId, setProjectId] = useState("");
  const [saJson, setSaJson] = useState("");
  const [guide, setGuide] = useState<ProvisionGuide | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const loadGuide = useCallback(async (pid: string) => {
    const q = encodeURIComponent(pid.trim() || "YOUR_PROJECT_ID");
    const res = await api<ProvisionGuide>(
      `/api/mcp/google/provision-guide?projectId=${q}&products=gmail,drive,calendar`,
    );
    setGuide(res);
  }, []);

  useEffect(() => {
    void loadGuide("YOUR_PROJECT_ID").catch(() => undefined);
  }, [loadGuide]);

  async function runProvision() {
    if (!saJson.trim()) {
      toast.error("请粘贴 Service Account JSON");
      return;
    }
    setBusy(true);
    try {
      let parsed: unknown = saJson;
      try {
        parsed = JSON.parse(saJson);
      } catch {
        /* 后端也会 parse string */
      }
      const res = await api<ProvisionGuide>("/api/mcp/google/provision", {
        method: "POST",
        json: {
          serviceAccountJson: parsed,
          projectId: projectId.trim() || undefined,
          products: ["gmail", "drive", "calendar"],
        },
      });
      setGuide(res);
      if (res.projectId) setProjectId(res.projectId);
      const okCount = (res.enabled?.length ?? 0) + (res.alreadyEnabled?.length ?? 0);
      if (res.failed?.length) {
        toast.error(`部分 API 启用失败（${res.failed.length}），请查看详情`);
      } else {
        toast.success(`已处理 ${okCount} 个 Cloud API，请继续创建 OAuth 客户端`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveClient() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error("请填写 Client ID 与 Client Secret");
      return;
    }
    setSaving(true);
    try {
      await api(`/api/mcp/oauth-apps/google?scope=${defaultScope}`, {
        method: "PUT",
        json: {
          enabled: true,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        },
      });
      toast.success("已保存 Google OAuth 客户端");
      onClientReady?.({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Google Cloud 自动供应（Workspace MCP）">
      <div className="mb-3 flex flex-wrap gap-2">
        <Badge variant="outline">API 可自动启用</Badge>
        <Badge variant="secondary">OAuth 客户端须 Console</Badge>
      </div>
      <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
        {guide?.limitation ||
          "Google 不允许通过公开 API 创建给 Gmail/Drive MCP 用的 Web OAuth 客户端。我们可用 Service Account 自动启用 Cloud API，再引导你完成客户端创建与权限勾选。"}
      </p>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">GCP Project ID（可选，默认取自 SA JSON）</Label>
          <Input
            value={projectId}
            placeholder="my-gcp-project"
            onChange={(e) => setProjectId(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Service Account JSON（不落库，仅本次调用）</Label>
          <textarea
            className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px]"
            placeholder='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
            value={saJson}
            onChange={(e) => setSaJson(e.target.value)}
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground">
            需具备 Service Usage Admin（或 Editor）。密钥不会写入数据库。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void runProvision()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            用 SA 自动启用 MCP API
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void loadGuide(projectId || "YOUR_PROJECT_ID").catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            仅刷新引导链接
          </Button>
        </div>

        {guide ? (
          <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
            {(guide.enabled?.length || guide.alreadyEnabled?.length || guide.failed?.length) ? (
              <div className="space-y-1 text-xs">
                {guide.enabled?.length ? (
                  <p>
                    <span className="font-medium">新启用：</span>
                    {guide.enabled.join(", ")}
                  </p>
                ) : null}
                {guide.alreadyEnabled?.length ? (
                  <p className="text-muted-foreground">
                    已启用：{guide.alreadyEnabled.join(", ")}
                  </p>
                ) : null}
                {guide.failed?.map((f) => (
                  <p key={f.service} className="text-destructive">
                    {f.service}: {f.error}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="space-y-1">
              <p className="text-xs font-medium">回调 URI</p>
              <code className="block break-all rounded-md bg-background px-2 py-1.5 text-[10px]">
                {guide.redirectUri}
              </code>
            </div>

            <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
              {(guide.checklist ?? []).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["同意屏幕", guide.consoleLinks.oauthConsent],
                  ["创建 OAuth 客户端", guide.consoleLinks.createOauthClient],
                  ["凭证列表", guide.consoleLinks.credentials],
                  ["API 库", guide.consoleLinks.enableApis],
                ] as const
              ).map(([label, href]) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] hover:bg-muted/60"
                >
                  {label}
                  <ExternalLink className="size-3 opacity-60" />
                </a>
              ))}
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium">需在同意屏幕添加的 Scopes</p>
              {guide.requiredScopes.map((g) => (
                <div key={g.product} className="text-[11px]">
                  <span className="font-medium">{g.product}：</span>
                  <code className="break-all text-muted-foreground">
                    {g.scopes.join(" ")}
                  </code>
                </div>
              ))}
            </div>

            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground">gcloud 脚本</summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 whitespace-pre-wrap">
                {guide.gcloudScript}
              </pre>
            </details>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium">粘贴 Console 创建的 OAuth 客户端</p>
          <div className="space-y-1.5">
            <Label className="text-xs">Client ID</Label>
            <Input
              value={clientId}
              placeholder="*.apps.googleusercontent.com"
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Client Secret</Label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button disabled={saving} onClick={() => void saveClient()}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            保存到本租户并启用
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
