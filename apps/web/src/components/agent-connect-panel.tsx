"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ConnectMeta = {
  publicBaseUrl: string;
  authorizationServer: {
    authorization_endpoint: string;
    token_endpoint: string;
  };
};

type FormatId = "mcpServers" | "servers" | "request";

const FORMATS: Array<{ value: FormatId; label: string }> = [
  { value: "mcpServers", label: "mcpServers 格式" },
  { value: "servers", label: "servers 格式" },
  { value: "request", label: "请求示例" },
];

function CopyBlock({ title, value }: { title: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${title}已复制`);
    } catch {
      toast.error("复制失败，请手动选择内容");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border border-border/80 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
        <code>{value}</code>
      </pre>
    </div>
  );
}

export type AgentConnectPanelProps = {
  agentId: string;
  agentSlug: string;
  mcpAgentUrl?: string;
  compact?: boolean;
  onConfigured?: () => void;
  disabled?: boolean;
};

export function AgentConnectPanel({
  agentId,
  agentSlug,
  mcpAgentUrl: mcpAgentUrlProp,
  compact = false,
  onConfigured,
  disabled,
}: AgentConnectPanelProps) {
  const [mcpUrl, setMcpUrl] = useState(mcpAgentUrlProp ?? "");
  const [slug, setSlug] = useState(agentSlug);
  const [meta, setMeta] = useState<ConnectMeta | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [format, setFormat] = useState<FormatId>("mcpServers");
  const [urlCopied, setUrlCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      mcpAgentUrlProp
        ? Promise.resolve({ mcpAgentUrl: mcpAgentUrlProp, slug: agentSlug })
        : api<{ mcpAgentUrl: string; slug: string }>(`/api/agents/${agentId}`),
      api<ConnectMeta>("/api/connect").catch(() => null),
    ])
      .then(([agent, connectMeta]) => {
        if (cancelled) return;
        setMcpUrl(agent.mcpAgentUrl);
        setSlug(agent.slug);
        setMeta(connectMeta);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, agentSlug, mcpAgentUrlProp]);

  const serverName = `zakura-${slug || "agent"}`;
  const keyPlaceholder = rawKey || "<access-key>";
  const snippets = useMemo(() => {
    const connection = {
      url: mcpUrl || "…",
      headers: { Authorization: `Bearer ${keyPlaceholder}` },
    };
    return {
      mcpServers: JSON.stringify({ mcpServers: { [serverName]: connection } }, null, 2),
      servers: JSON.stringify(
        { servers: { [serverName]: { type: "http", ...connection } } },
        null,
        2,
      ),
      request: `curl -s ${mcpUrl || "…"} \\\n+  -H "Authorization: Bearer ${keyPlaceholder}" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    } satisfies Record<FormatId, string>;
  }, [keyPlaceholder, mcpUrl, serverName]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setUrlCopied(true);
    } catch {
      toast.error("复制失败，请手动选择 URL");
    }
  }, [mcpUrl]);

  const mintKey = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api<{ rawKey: string }>(`/api/agents/${agentId}/keys`, {
        method: "POST",
        json: { name: compact ? "onboarding" : "connect" },
      });
      setRawKey(result.rawKey);
      setKeyCopied(false);
      onConfigured?.();
      toast.success("访问 Key 已生成，请立即保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [agentId, compact, onConfigured]);

  async function copyKey() {
    if (!rawKey) return;
    try {
      await navigator.clipboard.writeText(rawKey);
      setKeyCopied(true);
    } catch {
      toast.error("复制失败");
    }
  }

  if (loading) {
    return <Skeleton className={cn("w-full rounded-lg", compact ? "h-72" : "h-80")} />;
  }

  return (
    <div className={cn("space-y-6", compact && "mx-auto max-w-2xl")}>
      <section aria-labelledby={`mcp-url-${agentId}`}>
        <div>
          <p id={`mcp-url-${agentId}`} className="text-sm font-medium">MCP URL</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            在支持远程 MCP 的代理或自动化系统中添加此地址。
          </p>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2 pl-3">
          <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground sm:text-sm">
            {mcpUrl}
          </code>
          <Button type="button" size="sm" variant="outline" disabled={!mcpUrl} onClick={() => void copyUrl()}>
            {urlCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {urlCopied ? "已复制" : "复制 URL"}
          </Button>
        </div>
      </section>

      <section className="border-t border-border/70 pt-6" aria-labelledby={`access-key-${agentId}`}>
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p id={`access-key-${agentId}`} className="text-sm font-medium">访问凭据</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              请求时使用 <code className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</code>。
            </p>
          </div>
          {!rawKey ? (
            <Button type="button" disabled={busy || disabled} onClick={() => void mintKey()}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound className="size-4" />}
              {busy ? "正在生成…" : "生成访问 Key"}
            </Button>
          ) : null}
        </div>

        {rawKey ? (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-xs">
                {rawKey}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyKey()}>
                {keyCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {keyCopied ? "已复制" : "复制 Key"}
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              这个 Key 只显示一次，但可以随时生成新的。
            </p>
          </div>
        ) : null}
      </section>

      <section className="border-t border-border/70 pt-3">
        <Button
          type="button"
          variant="ghost"
          className="-ml-3 w-full justify-between px-3 text-muted-foreground hover:text-foreground"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          <span className="text-sm font-medium">高级配置</span>
          <ChevronDown className={cn("size-4 transition-transform duration-200", showAdvanced && "rotate-180")} />
        </Button>

        {showAdvanced ? (
          <div className="animate-in fade-in slide-in-from-top-1 mt-3 space-y-5 border-l border-border pl-4 duration-200">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">按接入端支持的配置结构选择：</p>
              <Select value={format} onValueChange={(value) => value && setFormat(value as FormatId)} items={FORMATS}>
                <SelectTrigger className="w-full sm:w-56" aria-label="配置格式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <CopyBlock title={FORMATS.find((item) => item.value === format)?.label ?? "配置"} value={snippets[format]} />

            {meta ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium hover:text-foreground">OAuth 端点</summary>
                <dl className="mt-3 grid gap-2 break-all rounded-lg bg-muted/30 p-3 font-mono text-[11px]">
                  <div><dt className="text-foreground">Authorization</dt><dd>{meta.authorizationServer.authorization_endpoint}</dd></div>
                  <div><dt className="text-foreground">Token</dt><dd>{meta.authorizationServer.token_endpoint}</dd></div>
                  <div><dt className="text-foreground">Protected resource</dt><dd>{meta.publicBaseUrl}/.well-known/oauth-protected-resource/mcp/agents/{slug}</dd></div>
                </dl>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
