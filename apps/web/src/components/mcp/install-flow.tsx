"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, KeyRound, Loader2, Package } from "lucide-react";
import { api } from "@/lib/api";
import {
  kindLabel,
  packageManagerLabel,
  type UnifiedMcpConfig,
} from "@/lib/mcp-config";
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
import { Badge } from "@/components/ui/badge";
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
  authRequired?: boolean;
};

type McpInstallFlowProps = {
  config: UnifiedMcpConfig;
  onComplete?: (result: InstallResult) => void;
  /** 阶段变化（供卡片顶栏进度 / 弹窗保活） */
  onPhaseChange?: (phase: McpInstallPhase) => void;
  className?: string;
  /** 隐藏本组件内进度条（由卡片顶栏承担） */
  hideProgress?: boolean;
};

/**
 * 统一安装面板：支持 HTTP OAuth / API Key、商店安装、stdio（npm / pypi / oci）。
 * 安装状态完全内聚；进度动画由外层卡片顶栏展示。
 */
export function McpInstallFlow({
  config: initial,
  onComplete,
  onPhaseChange,
  className,
  hideProgress = false,
}: McpInstallFlowProps) {
  const [config] = useState(initial);
  const [envValues, setEnvValues] = useState<Record<string, string>>(() => {
    const env: Record<string, string> = { ...(initial.env ?? {}) };
    for (const h of initial.envHints ?? []) {
      if (env[h.name] == null) env[h.name] = h.default ?? "";
    }
    return env;
  });
  const [phase, setPhaseState] = useState<McpInstallPhase>("idle");
  const setPhase = useCallback(
    (next: McpInstallPhase) => {
      setPhaseState(next);
      onPhaseChange?.(next);
    },
    [onPhaseChange],
  );
  const [error, setError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [showPat, setShowPat] = useState(false);
  const [pat, setPat] = useState("");
  const [showByo, setShowByo] = useState(
    () =>
      initial.oauth?.strategies?.includes("byo") === true ||
      initial.oauth?.tier === "B" ||
      initial.oauth?.providerId === "google" ||
      initial.oauth?.providerId === "github" ||
      initial.oauth?.providerId === "slack",
  );
  const [byoClientId, setByoClientId] = useState("");
  const [byoClientSecret, setByoClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => () => unsubRef.current?.(), []);

  useEffect(() => {
    if (config.kind !== "http" || config.auth !== "oauth") return;
    void api<{ redirectUri?: string }>("/api/mcp/oauth-redirect-uri")
      .then((res) => {
        if (res.redirectUri) setRedirectUri(res.redirectUri);
      })
      .catch(() => {
        /* ignore */
      });
  }, [config.kind, config.auth]);

  const busy = phase !== "idle" && phase !== "done" && phase !== "error";
  const isStdio = config.kind === "stdio";
  const allowPatFallback =
    config.oauth?.allowPatFallback === true ||
    config.id === "github" ||
    /github/i.test(config.mcpUrl ?? "");
  const isGoogle =
    config.oauth?.providerId === "google" ||
    /googleapis\.com|zakura:\/\/google-workspace/i.test(config.mcpUrl ?? "");
  const isSlack =
    config.oauth?.providerId === "slack" || /mcp\.slack\.com/i.test(config.mcpUrl ?? "");
  const isFigma = /mcp\.figma\.com/i.test(config.mcpUrl ?? "");

  const installHint = useMemo(() => {
    if (isStdio) {
      const pm = packageManagerLabel(config.packageManager);
      if (config.packageManager === "oci") {
        return `将通过 Docker socket 拉取 OCI 镜像并在隔离容器中运行（${pm}）。`;
      }
      return `将拉取 ${pm} 包并在容器中以 stdio 方式启动，过程可能需要数十秒。`;
    }
    if (isGoogle) {
      return "本地 Google Workspace 工具（直接调用 Gmail/Drive/Calendar API）。请填写 OAuth Client ID/Secret，或先在「设置 → OAuth 应用」保存。";
    }
    if (isSlack) {
      return "Slack 官方 MCP 不支持 DCR。请在 api.slack.com 创建 App（开启 MCP），填写 Client ID/Secret，或先在「设置 → OAuth 应用」保存 Slack。";
    }
    if (isFigma) {
      return "Figma 远程 MCP 目前主要开放给目录内客户端；若授权失败，需向 Figma 申请将本网关加入 waitlist。";
    }
    if (config.oauth?.tier === "B" || config.oauth?.providerId === "github") {
      return "可填写自备 OAuth App Client ID/Secret，由本服务自动完成授权；也可使用整站/本租户已保存的客户端，或改用 PAT。";
    }
    return null;
  }, [
    isStdio,
    config.packageManager,
    config.oauth?.tier,
    config.oauth?.providerId,
    isGoogle,
    isSlack,
    isFigma,
  ]);

  const pct = useMemo(() => {
    switch (phase) {
      case "creating":
        return 35;
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
      try {
        await api(`/api/instances/${id}/start`, { method: "POST" });
      } catch {
        /* 可能已在运行 */
      }
      setPhase("done");
      toast.success("已授权并启动");
      onComplete?.({ instanceId: id, slug: config.name });
    },
    [config.name, onComplete, setPhase],
  );

  const beginOauthWait = useCallback(
    (id: string, authorizeUrl: string, preparedTab?: Window | null) => {
      setPhase("awaiting_oauth");
      setInstanceId(id);
      unsubRef.current?.();
      unsubRef.current = listenMcpOauthCallback((msg) => {
        if (msg.instanceId && msg.instanceId !== id) return;
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

  async function installFromStore() {
    const meta = config.storeMeta;
    if (!meta) throw new Error("缺少商店安装元数据");
    setPhase("creating");
    const res = await api<{
      instance: { id: string; slug: string };
      started: boolean;
      startError?: string;
      authRequired?: boolean;
    }>("/api/mcp/store/install", {
      method: "POST",
      json: {
        name: meta.registryName,
        store: meta.storeId,
        prefer: meta.prefer,
        remoteUrl: meta.remoteUrl,
        packageIndex: meta.packageIndex,
        env: envValues,
        displayName: config.name,
        start: true,
      },
    });

    if (res.authRequired && meta.prefer === "http") {
      setInstanceId(res.instance.id);
      const preparedTab = prepareOauthTab();
      try {
        const { authorizeUrl } = await startUpstreamOauth(res.instance.id, {
          oauthClientId: byoClientId.trim() || undefined,
          oauthClientSecret: byoClientSecret.trim() || undefined,
        });
        beginOauthWait(res.instance.id, authorizeUrl, preparedTab);
        return;
      } catch (err) {
        if (preparedTab && !preparedTab.closed) preparedTab.close();
        setPhase("done");
        toast.message("已安装，上游需要 OAuth 授权");
        onComplete?.({
          instanceId: res.instance.id,
          slug: res.instance.slug,
          authRequired: true,
        });
        return;
      }
    }

    if (!res.started && res.startError) {
      throw new Error(res.startError);
    }
    setPhase("done");
    toast.success(`已安装并启动 ${res.instance.slug}`);
    onComplete?.({ instanceId: res.instance.id, slug: res.instance.slug });
  }

  async function installStdioDirect() {
    if (!config.command?.trim()) throw new Error("缺少 command");
    setPhase("creating");
    const res = await api<{
      instance: { id: string; slug: string };
      started?: boolean;
      startError?: string;
    }>("/api/mcp/import-stdio", {
      method: "POST",
      json: {
        name: config.name,
        command: config.command,
        args: config.args ?? [],
        env: envValues,
        image: config.image,
        workingDir: config.workingDir ?? "/data",
        packageManager: config.packageManager ?? "npm",
        start: true,
      },
    });
    if (!res.started && res.startError) {
      throw new Error(res.startError);
    }
    setPhase("done");
    toast.success(`已安装并启动 ${res.instance.slug}`);
    onComplete?.({ instanceId: res.instance.id, slug: res.instance.slug });
  }

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

  async function installHttpSimple() {
    setPhase("creating");
    const res = await api<{
      instance: { id: string; slug: string };
      started?: boolean;
      startError?: string;
      authRequired?: boolean;
    }>("/api/mcp/import", {
      method: "POST",
      json: {
        mcpUrl: config.mcpUrl!.trim(),
        name: config.name,
        authMode: config.auth === "apiKey" ? "apiKey" : "none",
        apiKey: config.auth === "apiKey" ? config.apiKey || pat : "",
        headerName: config.headerName ?? "Authorization",
        start: true,
      },
    });
    if (res.authRequired) {
      setPhase("done");
      onComplete?.({
        instanceId: res.instance.id,
        slug: res.instance.slug,
        authRequired: true,
      });
      return;
    }
    if (!res.started && res.startError) {
      throw new Error(res.startError);
    }
    setPhase("done");
    toast.success("已接入并启动");
    onComplete?.({ instanceId: res.instance.id, slug: res.instance.slug });
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
      toast.success("已接入并启动");
      onComplete?.({ instanceId: res.instance.id, slug: res.instance.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
    }
  }

  async function startInstall() {
    setError(null);
    try {
      if (config.source === "store" && config.storeMeta) {
        await installFromStore();
        return;
      }
      if (isStdio) {
        await installStdioDirect();
        return;
      }
      if (config.auth === "oauth") {
        await installOauth();
        return;
      }
      await installHttpSimple();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  }

  async function retryOauth() {
    if (!instanceId) {
      void startInstall();
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
  const needsOauthUi = config.kind === "http" && config.auth === "oauth";

  return (
    <div className={cn("relative", className)}>
      {!hideProgress && (busy || phase === "done" || phase === "error") ? (
        <div className="absolute inset-x-0 -top-1 z-10">
          <ProgressLinear
            flush
            value={pct}
            indeterminate={
              phase === "awaiting_oauth" || (phase === "creating" && isStdio)
            }
            barClassName={cn(phase === "error" && "bg-destructive")}
          />
        </div>
      ) : null}

      <div className="space-y-4 pt-1">
        <div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {kindLabel(config.kind)}
            </Badge>
            {isStdio ? (
              <Badge variant="outline" className="text-[10px]">
                {packageManagerLabel(config.packageManager)}
              </Badge>
            ) : null}
            {config.source === "store" ? (
              <Badge variant="outline" className="text-[10px]">
                社区商店
              </Badge>
            ) : null}
          </div>
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
          {isStdio && config.command ? (
            <code className="mt-2 block break-all text-[11px] text-muted-foreground">
              {config.command} {(config.args ?? []).join(" ")}
            </code>
          ) : null}
        </div>

        {envHints.length > 0 && (phase === "idle" || phase === "error") ? (
          <div className="space-y-2">
            {envHints.map((h) => (
              <div key={h.name} className="space-y-1">
                <Label className="text-xs">
                  {h.name}
                  {h.isRequired ? " *" : ""}
                </Label>
                {h.description ? (
                  <p className="text-[10px] text-muted-foreground">{h.description}</p>
                ) : null}
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

        {needsOauthUi && (phase === "idle" || phase === "error") && (
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
            请在弹出窗口完成授权，完成后将自动继续。
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

        {needsOauthUi && (showPat || (phase === "error" && allowPatFallback)) ? (
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
            <Button disabled={busy} onClick={() => void startInstall()}>
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : isStdio ? (
                <Package className="size-3.5" />
              ) : needsOauthUi ? (
                <KeyRound className="size-3.5" />
              ) : (
                <Package className="size-3.5" />
              )}
              {phase === "error"
                ? "重试安装"
                : needsOauthUi
                  ? "安装并授权"
                  : "确认安装"}
            </Button>
          ) : null}
          {phase === "awaiting_oauth" ? (
            <Button variant="outline" onClick={() => void retryOauth()}>
              重新打开授权窗口
            </Button>
          ) : null}
          {phase === "error" && allowPatFallback && needsOauthUi && !showPat ? (
            <Button variant="ghost" size="sm" onClick={() => setShowPat(true)}>
              使用访问令牌
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
