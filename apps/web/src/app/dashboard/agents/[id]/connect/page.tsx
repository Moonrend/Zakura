"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type ConnectMeta = {
  publicBaseUrl: string;
  authorizationServer: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    client_id_metadata_document_supported?: boolean;
  };
};

type TabId = "vscode" | "cursor" | "claude" | "apikey" | "oauth";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "claude", label: "Claude Desktop" },
  { id: "apikey", label: "API Key" },
  { id: "oauth", label: "OAuth 端点" },
];

function CopyBlock({
  title,
  value,
  language = "json",
}: {
  title?: string;
  value: string;
  language?: string;
}) {
  return (
    <div className="space-y-1.5">
      {title ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => {
              void navigator.clipboard.writeText(value);
              toast.success("已复制");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
        </div>
      ) : null}
      <pre
        className={cn(
          "overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground border border-border dark:bg-background",
          !title && "relative",
        )}
      >
        {!title ? (
          <Button
            size="sm"
            variant="secondary"
            className="absolute right-2 top-2 h-7"
            onClick={() => {
              void navigator.clipboard.writeText(value);
              toast.success("已复制");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <code data-lang={language}>{value}</code>
      </pre>
    </div>
  );
}

export default function AgentConnectPage() {
  const { id, agent } = useAgentDetail();

  const [meta, setMeta] = useState<ConnectMeta | null>(null);
  const [tab, setTab] = useState<TabId>("vscode");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await api<ConnectMeta>("/api/connect");
      setMeta(m);
      setRawKey(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mcpUrl = agent?.mcpAgentUrl ?? "";

  const cursorSnippet = useMemo(() => {
    if (!agent) return "";
    const key = rawKey || "<api-key>";
    return JSON.stringify(
      {
        mcpServers: {
          [`zakura-${agent.slug}`]: {
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${key}`,
            },
          },
        },
      },
      null,
      2,
    );
  }, [agent, mcpUrl, rawKey]);

  const claudeSnippet = useMemo(() => {
    if (!agent) return "";
    const key = rawKey || "<api-key>";
    return JSON.stringify(
      {
        mcpServers: {
          [`zakura-${agent.slug}`]: {
            type: "http",
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${key}`,
            },
          },
        },
      },
      null,
      2,
    );
  }, [agent, mcpUrl, rawKey]);

  const vscodeMcpJson = useMemo(() => {
    if (!agent) return "";
    return JSON.stringify(
      {
        servers: {
          [`zakura-${agent.slug}`]: {
            type: "http",
            url: mcpUrl,
          },
        },
      },
      null,
      2,
    );
  }, [agent, mcpUrl]);

  async function mintKey() {
    setBusy(true);
    try {
      const res = await api<{ rawKey: string }>(`/api/agents/${id}/keys`, {
        method: "POST",
        json: {},
      });
      setRawKey(res.rawKey);
      toast.success("已生成 Agent API Key（仅显示一次）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!agent || !meta) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader title="接入" />

      <code className="block break-all rounded-lg bg-muted/50 px-3 py-2 font-mono text-[11px] border border-border">
        {mcpUrl}
      </code>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v) setTab(v as TabId);
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value={tab}
          className="mt-4 space-y-4 rounded-lg border border-border bg-card p-4"
        >
          {tab === "vscode" ? (
            <>
              <div className="text-sm font-medium">VS Code</div>
              <CopyBlock title="MCP URL" value={mcpUrl} language="text" />
              <CopyBlock title="mcp.json" value={vscodeMcpJson} />
            </>
          ) : null}

          {tab === "cursor" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Cursor</span>
                <Button size="sm" onClick={() => void mintKey()} disabled={busy}>
                  <KeyRound className="h-3.5 w-3.5" />
                  生成 Key
                </Button>
              </div>
              {rawKey ? (
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]">
                  {rawKey}
                </code>
              ) : null}
              <CopyBlock title="mcp.json" value={cursorSnippet} />
            </>
          ) : null}

          {tab === "claude" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Claude Desktop</span>
                <Button size="sm" onClick={() => void mintKey()} disabled={busy}>
                  <KeyRound className="h-3.5 w-3.5" />
                  生成 Key
                </Button>
              </div>
              {rawKey ? (
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]">
                  {rawKey}
                </code>
              ) : null}
              <CopyBlock title="claude_desktop_config.json" value={claudeSnippet} />
            </>
          ) : null}

          {tab === "apikey" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">API Key</span>
                <Button size="sm" onClick={() => void mintKey()} disabled={busy}>
                  <KeyRound className="h-3.5 w-3.5" />
                  生成 Key
                </Button>
                <Button nativeButton={false} render={<Link href="/dashboard/keys" />}>
                  Keys
                </Button>
              </div>
              {rawKey ? (
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]">
                  {rawKey}
                </code>
              ) : null}
              <CopyBlock
                title="请求头"
                language="http"
                value={`Authorization: Bearer ${rawKey || "<api-key>"}`}
              />
              <CopyBlock
                title="curl"
                language="bash"
                value={`curl -s ${mcpUrl} \\
  -H "Authorization: Bearer ${rawKey || "<api-key>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
              />
            </>
          ) : null}

          {tab === "oauth" ? (
            <>
              <div className="text-sm font-medium">OAuth 端点</div>
              <div className="grid gap-2">
                {(
                  [
                    [
                      "Metadata (RFC 8414)",
                      `${meta.publicBaseUrl}/.well-known/oauth-authorization-server`,
                    ],
                    [
                      "OIDC Discovery",
                      `${meta.publicBaseUrl}/.well-known/openid-configuration`,
                    ],
                    [
                      "Protected Resource",
                      `${meta.publicBaseUrl}/.well-known/oauth-protected-resource/mcp/agents/${agent?.slug ?? "{slug}"}`,
                    ],
                    ["Authorization", meta.authorizationServer.authorization_endpoint],
                    ["Token", meta.authorizationServer.token_endpoint],
                    ["UserInfo (OIDC)", `${meta.publicBaseUrl}/userinfo`],
                    ["Registration (DCR)", meta.authorizationServer.registration_endpoint],
                  ] as const
                ).map(([label, url]) => (
                  <div
                    key={label}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div>
                      <div className="text-[11px] text-muted-foreground">{label}</div>
                      <code className="break-all text-[11px]">{url}</code>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(url);
                        toast.success("已复制");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="rounded-md border px-3 py-2 text-[12px]">
                <span className="text-muted-foreground">CIMD：</span>
                {meta.authorizationServer.client_id_metadata_document_supported ? (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    已公布（client_id_metadata_document_supported=true）
                  </span>
                ) : (
                  <span className="font-medium text-destructive">
                    未公布 — 请重新部署服务端后再在 ChatGPT 中选择 CIMD
                  </span>
                )}
              </div>
              <a
                className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                href={`${meta.publicBaseUrl}/.well-known/oauth-authorization-server`}
                target="_blank"
                rel="noreferrer"
              >
                打开 Metadata
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
