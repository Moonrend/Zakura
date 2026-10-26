"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { SpaceItem, SpaceKey } from "@/lib/spaces";
import {
  buildConnectSnippets,
  CONNECT_KEY_ACCESS,
  connectKeyAccessLabel,
  connectKeyScopes,
  keySupportsProtocol,
  type ConnectKeyAccess,
  type ConnectProtocol,
} from "@/lib/space-connect";
import { SpaceGatewaySettings } from "@/components/space-gateway-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type AccessKey = Omit<SpaceKey, "rawKey">;
type ConnectMeta = {
  publicBaseUrl: string;
  authorizationServer?: { authorization_endpoint: string; token_endpoint: string };
  spaces?: Array<{ id: string; mcpUrl: string }>;
};
type McpFormat = "mcpServers" | "servers" | "request";

const MCP_FORMATS = [
  { value: "mcpServers", label: "mcpServers" },
  { value: "servers", label: "servers" },
  { value: "request", label: "cURL" },
];
const EXPIRIES = [
  { value: "never", label: "永不过期" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
];

function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button type="button" size="sm" variant="ghost" className="shrink-0" disabled={!value} onClick={async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      } catch {
        toast.error("复制失败，请手动选择内容");
      }
    }}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : label}
    </Button>
  );
}

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border/70">
      <button type="button" className="weight-hover flex w-full items-center justify-between gap-3 rounded-sm py-3 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
        <ChevronDown className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? <div className="pb-4 pt-1">{children}</div> : null}
    </div>
  );
}

export function SpaceAccessPanel({ space, initialProtocol = "mcp" }: { space: SpaceItem; initialProtocol?: ConnectProtocol }) {
  const [protocol, setProtocol] = useState<ConnectProtocol>(initialProtocol);
  const [meta, setMeta] = useState<ConnectMeta | null>(null);
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [format, setFormat] = useState<McpFormat>("mcpServers");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ConnectKeyAccess>("both");
  const [expiry, setExpiry] = useState("never");
  const [created, setCreated] = useState<SpaceKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => { setProtocol(initialProtocol); }, [initialProtocol]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([api<ConnectMeta>("/api/connect"), api<AccessKey[]>("/api/api-keys")])
      .then(([connection, rows]) => {
        if (cancelled) return;
        setMeta(connection);
        setKeys(rows.filter((key) => key.spaceId === space.id));
      }).catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [space.id, retry]);

  const mcpUrl = space.mcpUrl || meta?.spaces?.find((item) => item.id === space.id)?.mcpUrl || "";
  const publicBaseUrl = meta?.publicBaseUrl.replace(/\/+$/, "") ?? "";
  const gatewayBaseUrl = publicBaseUrl ? `${publicBaseUrl}/v1` : "";
  const snippetKey = created && keySupportsProtocol(created.scopes, protocol) ? created.rawKey : undefined;
  const snippets = buildConnectSnippets({ mcpUrl, gatewayBaseUrl, spaceSlug: space.slug, key: snippetKey });
  const snippet = protocol === "mcp" ? snippets[format] : snippets.gateway;

  function openCreate() {
    setCreated(null);
    setName("");
    setAccess("both");
    setExpiry("never");
    setOpen(true);
  }

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<SpaceKey>(`/api/spaces/${space.id}/keys`, {
        method: "POST",
        json: {
          name: name.trim() || "connect",
          scopes: connectKeyScopes(access),
          expiresAt: expiry === "never" ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString(),
        },
      });
      const { rawKey: _rawKey, ...key } = result;
      setKeys((current) => [key, ...current]);
      setCreated(result);
      toast.success("Key 已创建");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(key: AccessKey) {
    if (!window.confirm(`撤销「${key.name}」？使用它的客户端将立即无法访问。`)) return;
    setRevoking(key.id);
    try {
      await api(`/api/api-keys/${key.id}`, { method: "DELETE" });
      setKeys((current) => current.filter((item) => item.id !== key.id));
      if (created?.id === key.id) setCreated(null);
      toast.success("Key 已撤销");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(null);
    }
  }

  if (loading) return <PageLoading />;
  if (error) return (
    <div role="alert" className="space-y-2">
      <p className="text-sm text-muted-foreground">接入信息加载失败：{error}</p>
      <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>重试</Button>
    </div>
  );

  return (
    <div className="space-y-7">
      <Tabs value={protocol} onValueChange={(value) => setProtocol(value as ConnectProtocol)} className="gap-4">
        <TabsList variant="line" aria-label="接入方式">
          <TabsTrigger value="mcp" className="px-3">MCP</TabsTrigger>
          <TabsTrigger value="gateway" className="px-3">AI Gateway</TabsTrigger>
        </TabsList>
        <TabsContent value="mcp" className="space-y-3">
          <p className="text-sm text-muted-foreground">在远程 MCP 客户端中填写此地址，使用 Streamable HTTP。</p>
          <div className="space-y-1.5">
            <Label htmlFor="connect-mcp-url" className="text-xs text-muted-foreground">MCP URL</Label>
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-input bg-background py-1 pl-3 pr-1">
              <input id="connect-mcp-url" readOnly value={mcpUrl} className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <CopyButton value={mcpUrl} />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="gateway" className="space-y-3">
          <p className="text-sm text-muted-foreground">在模型客户端中填写 Base URL 和 Key。</p>
          <div className="space-y-1.5">
            <Label htmlFor="connect-gateway-url" className="text-xs text-muted-foreground">Base URL</Label>
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-input bg-background py-1 pl-3 pr-1">
              <input id="connect-gateway-url" readOnly value={gatewayBaseUrl} className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <CopyButton value={gatewayBaseUrl} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">支持 Chat Completions、Responses 和 Messages。</p>
        </TabsContent>
        <p className="text-xs text-muted-foreground">使用下方 Key 作为 Bearer Token，权限限于当前空间。</p>
        <Disclosure title="配置示例">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              {protocol === "mcp" ? (
                <Select value={format} onValueChange={(value) => value && setFormat(value as McpFormat)} items={MCP_FORMATS}>
                  <SelectTrigger className="h-8 w-40" aria-label="配置格式"><SelectValue /></SelectTrigger>
                  <SelectContent>{MCP_FORMATS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                </Select>
              ) : <p className="text-xs text-muted-foreground">环境变量</p>}
              <CopyButton value={snippet} label="复制配置" />
            </div>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed"><code>{snippet}</code></pre>
            {protocol === "mcp" && meta?.authorizationServer ? (
              <details className="pt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">OAuth 端点</summary>
                <dl className="mt-3 space-y-3">
                  <div><dt>Authorization</dt><dd className="mt-1 break-all font-mono">{meta.authorizationServer.authorization_endpoint}</dd></div>
                  <div><dt>Token</dt><dd className="mt-1 break-all font-mono">{meta.authorizationServer.token_endpoint}</dd></div>
                  <div><dt>Protected resource</dt><dd className="mt-1 break-all font-mono">{publicBaseUrl}/.well-known/oauth-protected-resource/mcp/spaces/{space.slug}</dd></div>
                </dl>
              </details>
            ) : null}
          </div>
        </Disclosure>
      </Tabs>

      <section aria-labelledby="connect-keys-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 id="connect-keys-title" className="text-sm font-medium">访问密钥</h2>
            <p className="text-xs text-muted-foreground">MCP 和 AI Gateway 可共用一把 Key。</p>
          </div>
          <Button size="sm" onClick={openCreate}><Plus className="size-3.5" />创建 Key</Button>
        </div>
        {keys.length ? (
          <Table>
            <TableHeader><TableRow>
              <TableHead>名称</TableHead><TableHead>权限</TableHead><TableHead>最近使用</TableHead><TableHead>有效期</TableHead><TableHead className="w-10"><span className="sr-only">操作</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell title={`创建于 ${new Date(key.createdAt).toLocaleString()}`}>
                  <p className="font-medium">{key.name}</p>
                  <code className="text-[11px] text-muted-foreground">{key.keyPrefix}…</code>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{connectKeyAccessLabel(key.scopes)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "从未"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{key.expiresAt ? new Date(key.expiresAt).toLocaleString() : "永不过期"}</TableCell>
                <TableCell><Button size="icon-sm" variant="ghost" aria-label={`撤销 ${key.name}`} title="撤销 Key" disabled={revoking !== null} className="text-muted-foreground hover:text-destructive" onClick={() => void revokeKey(key)}>
                  {revoking === key.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </Button></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        ) : <p className="py-3 text-sm text-muted-foreground">暂无 Key，创建后即可在客户端使用。</p>}
      </section>

      {protocol === "gateway" ? (
        <Disclosure title="模型设置"><SpaceGatewaySettings spaceId={space.id} /></Disclosure>
      ) : null}

      <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{created ? "Key 已创建" : "创建 Key"}</DialogTitle>
            <DialogDescription>{created ? "仅显示一次，请复制保存。" : "仅访问当前空间，可选择接入权限。"}</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-4">
              <code className="block select-all break-all rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">{created.rawKey}</code>
              <DialogFooter><CopyButton value={created.rawKey} label="复制 Key" /><Button onClick={() => setOpen(false)}>完成</Button></DialogFooter>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={(event) => void createKey(event)}>
              <div className="space-y-2"><Label htmlFor="connect-key-name">名称</Label><Input id="connect-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：桌面客户端" autoFocus required /></div>
              <div className="space-y-2">
                <Label htmlFor="connect-key-access">权限</Label>
                <Select value={access} onValueChange={(value) => value && setAccess(value as ConnectKeyAccess)} items={CONNECT_KEY_ACCESS}>
                  <SelectTrigger id="connect-key-access"><SelectValue /></SelectTrigger>
                  <SelectContent>{CONNECT_KEY_ACCESS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="connect-key-expiry">有效期</Label>
                <Select value={expiry} onValueChange={(value) => value && setExpiry(value)} items={EXPIRIES}>
                  <SelectTrigger id="connect-key-expiry"><SelectValue /></SelectTrigger>
                  <SelectContent>{EXPIRIES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}创建</Button></DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
