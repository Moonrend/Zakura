"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, KeyRound, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { type UnifiedMcpConfig } from "@/lib/mcp-config";
import {
  listenMcpOauthCallback,
  navigateOauthTab,
  openOauthAuthorizeTab,
  prepareOauthTab,
  startUpstreamOauth,
  verifyUpstreamOauth,
} from "@/lib/mcp-oauth";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type McpInstallPhase =
  | "idle"
  | "creating"
  | "awaiting_oauth"
  | "verifying"
  | "done"
  | "error";

type InstallResult = {
  instanceId: string;
  slug: string;
};

type McpInstallFlowProps = {
  config: UnifiedMcpConfig;
  onComplete?: (result: InstallResult) => void;
  className?: string;
};

/**
 * 安装面板：OAuth 自动授权。
 * Google/GitHub 等无 DCR 时，支持用户填写自备 OAuth Client ID/Secret，
 * 由服务端全程完成授权码交换（非 Google API Key）。
 */
export function McpInstallFlow({
  config: initial,
  onComplete,
  className,
}: McpInstallFlowProps) {
  const [config] = useState(initial);
  const [envValues, setEnvValues] = useState<Record<string, string>>(() => {
    const env: Record<string, string> = { ...(initial.env ?? {}) };
    for (const h of initial.envHints ?? []) {
      if (env[h.name] == null) env[h.name] = h.default ?? "";
    }
    return env;
  });
  const [phase, setPhase] = useState<McpInstallPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [showPat, setShowPat] = useState(false);
  const [pat, setPat] = useState("");
  const [showByo, setShowByo] = useState(
    () =>
      initial.oauth?.strategies?.includes("byo") === true ||
      initial.oauth?.tier === "B" ||
      initial.oauth?.providerId === "google" ||
      initial.oauth?.providerId === "github",
  );
  const [byoClientId, setByoClientId] = useState("");
  const [byoClientSecret, setByoClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => () => unsubRef.current?.(), []);

  useEffect(() => {
    void api<{ redirectUri?: string }>("/api/mcp/oauth-redirect-uri")
      .then((res) => {
        if (res.redirectUri) setRedirectUri(res.redirectUri);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);
  const busy = phase !== "idle" && phase !== "done" && phase !== "error";
  const allowPatFallback =
    config.oauth?.allowPatFallback === true ||
    config.id === "github" ||
    /github/i.test(config.mcpUrl ?? "");
  const isGoogle =
    config.oauth?.providerId === "google" ||
    /googleapis\.com/i.test(config.mcpUrl ?? "");

  const installHint = useMemo(() => {
    if (isGoogle) {
      return "Google Workspace MCP 不支持 API Key。请填写你在 Google Cloud 创建的 OAuth 客户端（Client ID/Secret），安装后将自动打开授权页完成登录。也可先在「设置 → OAuth 应用」保存本租户客户端。";
    }
    if (config.oauth?.tier === "B" || config.oauth?.providerId === "github") {
      return "可填写自备 OAuth App Client ID/Secret，由本服务自动完成授权；也可使用整站/本租户已保存的客户端，或改用 PAT。";
    }
    return null;
  }, [config.oauth?.tier, config.oauth?.providerId, isGoogle]);

  const pct = useMemo(() => {
    switch (phase) {
      case "creating":
        return 30;
      case "awaiting_oauth":
        return null;
      case "verifying":
        return 80;
      case "done":
        return 100;
      case "error":
        return 100;
      default:
        return 0;
    }
  }, [phase]);

  const finishOauth = useCallback(
    async (id: string) => {
      setPhase("verifying");
      try {
        await verifyUpstreamOauth(id);
      } catch {
        /* non-fatal */
      }
      setPhase("done");
      toast.success("已授权并接入");
      onComplete?.({ instanceId: id, slug: config.name });
    },
    [config.name, onComplete],
  );

  const beginOauthWait = useCallback(
    (id: string, authorizeUrl: string, preparedTab?: Window | null) => {
      setPhase("awaiting_oauth");
      setInstanceId(id);
      unsubRef.current?.();
      unsubRef.current = listenMcpOauthCallback((msg) => {
        if (!msg.ok) {
          setError(msg.error || "OAuth 授权失败");
          setPhase("error");
          toast.error(msg.error || "OAuth 授权失败");
          return;
        }
        void finishOauth(msg.instanceId || id);
      });
      if (preparedTab) navigateOauthTab(preparedTab, authorizeUrl);
      else openOauthAuthorizeTab(authorizeUrl);
    },
    [finishOauth],
  );

  async function installOauth() {
    setError(null);
    const preparedTab = prepareOauthTab();
    setPhase("creating");
    try {
      const res = await api<{
        instance: { id: string; slug: string };
        oauth?: {
          ok: boolean;
          authorizeUrl?: string;
          error?: string;
          needsPatFallback?: boolean;
          needsByoClient?: boolean;
          redirectUri?: string;
          clientSource?: string;
        };
      }>("/api/mcp/import", {
        method: "POST",
        json: {
          mcpUrl: config.mcpUrl!.trim(),
          name: config.name,
          authMode: "oauth",
          start: false,
          oauthClientId: byoClientId.trim() || undefined,
          oauthClientSecret: byoClientSecret.trim() || undefined,
        },
      });
      setInstanceId(res.instance.id);
      if (res.oauth?.redirectUri) setRedirectUri(res.oauth.redirectUri);

      if (res.oauth?.ok && res.oauth.authorizeUrl) {
        beginOauthWait(res.instance.id, res.oauth.authorizeUrl, preparedTab);
        return;
      }

      if (preparedTab && !preparedTab.closed) preparedTab.close();
      const msg =
        res.oauth?.error ||
        "缺少 OAuth 客户端。请填写自备 Client ID/Secret，或在设置中保存。";
      setError(msg);
      setPhase("error");
      if (res.oauth?.needsByoClient) setShowByo(true);
      if (allowPatFallback || res.oauth?.needsPatFallback) setShowPat(true);
    } catch (err) {
      if (preparedTab && !preparedTab.closed) preparedTab.close();
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
      setShowByo(true);
      if (allowPatFallback) setShowPat(true);
    }
  }

  async function installWithPat() {
    if (!pat.trim()) {
      toast.error("请填写访问令牌");
      return;
    }
    setError(null);
    setPhase("creating");
    try {
      const res = await api<{
        instance: { id: string; slug: string };
        started?: boolean;
      }>("/api/mcp/import", {
        method: "POST",
        json: {
          mcpUrl: config.mcpUrl!.trim(),
          name: config.name,
          authMode: "apiKey",
          apiKey: pat.trim(),
          headerName: "Authorization",
          start: true,
        },
      });
      setPhase("done");
      toast.success("已接入");
      onComplete?.({ instanceId: res.instance.id, slug: res.instance.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
    }
  }

  async function retryOauth() {
    if (!instanceId) {
      void installOauth();
      return;
    }
    try {
      setError(null);
      const preparedTab = prepareOauthTab();
      const { authorizeUrl } = await startUpstreamOauth(instanceId, {
        oauthClientId: byoClientId.trim() || undefined,
        oauthClientSecret: byoClientSecret.trim() || undefined,
      });
      beginOauthWait(instanceId, authorizeUrl, preparedTab);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
      setShowByo(true);
      if (allowPatFallback) setShowPat(true);
    }
  }

  const envHints = config.envHints ?? [];
  const patLabel =
    config.oauth?.providerId === "github" || /github/i.test(config.mcpUrl ?? "")
      ? "改用 GitHub PAT / 令牌"
      : "改用访问令牌";

  return (
    <div className={cn("relative", className)}>
      {(busy || phase === "done" || phase === "error") && (
        <div className="absolute inset-x-0 -top-1 z-10">
          <ProgressLinear
            flush
            value={pct}
            indeterminate={phase === "awaiting_oauth"}
            barClassName={cn(phase === "error" && "bg-destructive")}
          />
        </div>
      )}

      <div className="space-y-4 pt-1">
        <div>
          <p className="text-sm text-muted-foreground">{config.description}</p>
          {installHint ? (
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
              {installHint}
            </p>
          ) : null}
          {config.mcpUrl ? (
            <code className="mt-2 block truncate text-[11px] text-muted-foreground">
              {config.mcpUrl}
            </code>
          ) : null}
        </div>

        {envHints.length > 0 && phase === "idle" ? (
          <div className="space-y-2">
            {envHints.map((h) => (
              <div key={h.name} className="space-y-1">
                <Label className="text-xs">
                  {h.name}
                  {h.isRequired ? " *" : ""}
                </Label>
                <Input
                  type={h.isSecret ? "password" : "text"}
                  value={envValues[h.name] ?? ""}
                  onChange={(e) =>
                    setEnvValues((prev) => ({
                      ...prev,
                      [h.name]: e.target.value,
                    }))
                  }
                />
              </div>
            ))}
          </div>
        ) : null}

        {(phase === "idle" || phase === "error") && (
          <div className="space-y-2 border-t border-border pt-3">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left text-xs font-medium"
              onClick={() => setShowByo((v) => !v)}
            >
              <span>自备 OAuth 客户端（推荐）</span>
              <ChevronDown
                className={cn("size-3.5 transition-transform", showByo && "rotate-180")}
              />
            </button>
            {showByo ? (
              <div className="space-y-2">
                {isGoogle ? (
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    请使用 Google Cloud →「OAuth 客户端」的 ID/Secret，不要填写「API
                    密钥」。类型选 Web 应用，并添加下方回调 URI。
                  </p>
                ) : null}
                {redirectUri ? (
                  <div className="space-y-1">
                    <Label className="text-xs">回调 URI（填入你的 OAuth App）</Label>
                    <code className="block break-all rounded-md bg-muted/50 px-2 py-1.5 text-[10px]">
                      {redirectUri}
                    </code>
                  </div>
                ) : null}
                <div className="space-y-1">
                  <Label className="text-xs">Client ID</Label>
                  <Input
                    value={byoClientId}
                    placeholder={isGoogle ? "*.apps.googleusercontent.com" : "Ov23…"}
                    onChange={(e) => setByoClientId(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Client Secret</Label>
                  <Input
                    type="password"
                    value={byoClientSecret}
                    onChange={(e) => setByoClientSecret(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}

        {phase === "awaiting_oauth" ? (
          <p className="text-xs text-muted-foreground">
            请在新标签页完成授权，完成后将自动继续。
          </p>
        ) : null}

        {phase === "done" ? (
          <p className="flex items-center gap-1.5 text-sm">
            <Check className="size-3.5" />
            已接入 {config.name}
          </p>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive leading-relaxed">{error}</p>
        ) : null}

        {showPat || (phase === "error" && allowPatFallback) ? (
          <div className="space-y-2 border-t border-border pt-3">
            <Label className="text-xs">{patLabel}</Label>
            <Input
              type="password"
              placeholder={
                /github/i.test(config.mcpUrl ?? "") ? "ghp_…" : "token…"
              }
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void installWithPat()}
            >
              使用令牌安装
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {phase === "idle" || phase === "error" ? (
            <Button disabled={busy} onClick={() => void installOauth()}>
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <KeyRound className="size-3.5" />
              )}
              {phase === "error" ? "重试 OAuth" : "安装并授权"}
            </Button>
          ) : null}
          {phase === "awaiting_oauth" ? (
            <Button variant="outline" onClick={() => void retryOauth()}>
              重新打开授权页
            </Button>
          ) : null}
          {phase === "error" && allowPatFallback && !showPat ? (
            <Button variant="ghost" size="sm" onClick={() => setShowPat(true)}>
              使用访问令牌
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
