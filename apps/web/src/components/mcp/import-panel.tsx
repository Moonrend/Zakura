"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fromStdioPackage } from "@/lib/mcp-config";
import {
  listenMcpOauthCallback,
  navigateOauthTab,
  prepareOauthTab,
} from "@/lib/mcp-oauth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

type Mode = "url" | "vscode" | "stdio";
type AuthMode = "none" | "apiKey" | "oauth";

type ParsedEntry = {
  key: string;
  kind: "http" | "stdio";
  name: string;
  mcpUrl?: string;
  command?: string;
  args?: string[];
  packageManager?: string;
  importPreview: {
    providerId: string;
    name: string;
    slug: string;
  };
};

const VSCODE_EXAMPLE = `{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    "markitdown": {
      "command": "uvx",
      "args": ["markitdown-mcp"]
    }
  }
}`;

function guessNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "MCP";
  }
}

type McpImportPanelProps = {
  /** 嵌入 onboarding 时不跳出当前流程。 */
  embedded?: boolean;
  onComplete?: (result: { instanceIds: string[] }) => void;
};

export function McpImportPanel({ embedded = false, onComplete }: McpImportPanelProps = {}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("url");
  const [busy, setBusy] = useState(false);

  const [mcpUrl, setMcpUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [apiKey, setApiKey] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [startAfter, setStartAfter] = useState(true);

  const [vscodeJson, setVscodeJson] = useState("");
  const [parsed, setParsed] = useState<ParsedEntry[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const [stdioPkg, setStdioPkg] = useState("@modelcontextprotocol/server-filesystem");
  const [stdioManager, setStdioManager] = useState<"npm" | "pypi">("npm");
  const [stdioExtraArgs, setStdioExtraArgs] = useState("/data");
  const [stdioName, setStdioName] = useState("");

  const autoName = useMemo(() => {
    if (displayName.trim()) return displayName.trim();
    if (mcpUrl.trim()) return guessNameFromUrl(mcpUrl.trim());
    return "";
  }, [displayName, mcpUrl]);

  async function importUrl() {
    if (!mcpUrl.trim()) {
      toast.error("请填写 MCP URL");
      return;
    }
    setBusy(true);
    const preparedTab = authMode === "oauth" ? prepareOauthTab() : null;
    try {
      const res = await api<{
        instance: { id: string; slug: string };
        authRequired?: boolean;
        oauth?: { ok: boolean; authorizeUrl?: string; error?: string };
        started?: boolean;
        startError?: string;
      }>("/api/mcp/import", {
        method: "POST",
        json: {
          mcpUrl: mcpUrl.trim(),
          name: autoName || undefined,
          authMode,
          apiKey: authMode === "apiKey" ? apiKey : "",
          headerName,
          start: authMode === "oauth" ? false : startAfter,
        },
      });

      if (authMode === "oauth") {
        if (res.oauth?.ok && res.oauth.authorizeUrl) {
          toast.message("已创建实例，请在弹出窗口完成授权");
          navigateOauthTab(preparedTab, res.oauth.authorizeUrl);
          const unsub = listenMcpOauthCallback((msg) => {
            unsub();
            if (msg.ok) {
              toast.success("OAuth 授权成功");
              onComplete?.({ instanceIds: [msg.instanceId || res.instance.id] });
              if (!embedded) {
                router.push(`/dashboard/mcp/${msg.instanceId || res.instance.id}`);
              }
            } else {
              toast.error(msg.error || "OAuth 授权失败");
              if (!embedded) router.push(`/dashboard/mcp/${res.instance.id}?oauth=1`);
            }
          });
          return;
        }
        if (preparedTab && !preparedTab.closed) preparedTab.close();
        toast.error(res.oauth?.error || "OAuth 启动失败");
        if (!embedded) router.push(`/dashboard/mcp/${res.instance.id}?oauth=1`);
        return;
      }

      if (res.authRequired) {
        toast.message("已导入，上游需要授权");
        onComplete?.({ instanceIds: [res.instance.id] });
        if (!embedded) router.push(`/dashboard/mcp/${res.instance.id}?oauth=1`);
        return;
      }

      toast.success(
        res.started
          ? `已导入 ${res.instance.slug}`
          : `已创建（${res.startError ?? "未启动"}）`,
      );
      onComplete?.({ instanceIds: [res.instance.id] });
      if (!embedded) router.push(`/dashboard/mcp/${res.instance.id}`);
    } catch (err) {
      if (preparedTab && !preparedTab.closed) preparedTab.close();
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function parseVscode() {
    setBusy(true);
    try {
      const res = await api<{ entries: ParsedEntry[] }>("/api/mcp/parse-vscode", {
        method: "POST",
        json: { config: vscodeJson },
      });
      setParsed(res.entries);
      setSelectedKeys(new Set(res.entries.map((e) => e.key)));
      toast.success(`识别到 ${res.entries.length} 个服务器`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setParsed(null);
    } finally {
      setBusy(false);
    }
  }

  async function importVscode() {
    if (!parsed?.length) {
      await parseVscode();
      return;
    }
    const keys = [...selectedKeys];
    if (!keys.length) {
      toast.error("请至少选择一个服务器");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{
        count: number;
        results: Array<{
          instance: { id: string };
          slug: string;
          started: boolean;
          startError?: string;
        }>;
      }>("/api/mcp/import-vscode", {
        method: "POST",
        json: { config: vscodeJson, keys, start: startAfter },
      });
      toast.success(`已导入 ${res.count} 个 MCP`);
      onComplete?.({ instanceIds: res.results.map((result) => result.instance.id) });
      if (!embedded) router.push("/dashboard/mcp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function importStdio() {
    const pkg = stdioPkg.trim();
    if (!pkg) {
      toast.error("请填写包名");
      return;
    }
    setBusy(true);
    try {
      const extra = stdioExtraArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const config = fromStdioPackage({
        name: stdioName.trim() || undefined,
        packageName: pkg,
        packageManager: stdioManager,
        extraArgs: extra,
      });
      const res = await api<{
        instance: { id: string; slug: string };
        started: boolean;
        startError?: string;
      }>("/api/mcp/import-stdio", {
        method: "POST",
        json: {
          name: config.name,
          command: config.command,
          args: config.args,
          packageManager: config.packageManager,
          start: startAfter,
        },
      });
      toast.success(
        res.started
          ? `已启动 ${res.instance.slug}`
          : `已创建（${res.startError ?? "未启动"}）`,
      );
      onComplete?.({ instanceIds: [res.instance.id] });
      if (!embedded) router.push(`/dashboard/mcp/${res.instance.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1">
        {(
          [
            ["url", "URL"],
            ["vscode", "VS Code JSON"],
            ["stdio", "npm / uvx"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={mode === id ? "default" : "outline"}
            onClick={() => setMode(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === "url" ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label>MCP URL</Label>
            <Input
              required
              type="url"
              placeholder="https://api.example.com/mcp"
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>显示名称（可选）</Label>
            <Input
              placeholder={autoName || "自动取自域名"}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>认证方式</Label>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["none", "无"],
                  ["apiKey", "API Key"],
                  ["oauth", "OAuth 2.1 注册"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  size="sm"
                  variant={authMode === id ? "default" : "outline"}
                  onClick={() => setAuthMode(id)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {authMode === "apiKey" ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Header</Label>
                <Input
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {authMode !== "oauth" ? (
            <div className="flex items-center justify-between">
              <Label>导入后启动</Label>
              <Switch checked={startAfter} onCheckedChange={setStartAfter} />
            </div>
          ) : null}

          <Button className="w-full" disabled={busy} onClick={() => void importUrl()}>
            {busy
              ? "处理中…"
              : authMode === "oauth"
                ? "创建并授权"
                : "导入"}
          </Button>
        </div>
      ) : null}

      {mode === "vscode" ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>粘贴 mcp.json</Label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVscodeJson(VSCODE_EXAMPLE)}
              >
                填入示例
              </Button>
            </div>
            <Textarea
              className="font-mono text-xs"
              rows={12}
              placeholder='{ "mcpServers": { ... } } 或 VS Code { "servers": { ... } }'
              value={vscodeJson}
              onChange={(e) => {
                setVscodeJson(e.target.value);
                setParsed(null);
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              支持 Cursor / VS Code 格式
            </p>
          </div>

          {parsed ? (
            <div className="space-y-2">
              <Label>将导入</Label>
              {parsed.map((e) => (
                <label
                  key={e.key}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 border border-border"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedKeys.has(e.key)}
                    onChange={(ev) => {
                      setSelectedKeys((prev) => {
                        const next = new Set(prev);
                        if (ev.target.checked) next.add(e.key);
                        else next.delete(e.key);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-sm font-medium">{e.name}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {e.kind === "http"
                          ? "HTTP"
                          : e.packageManager === "pypi"
                            ? "uvx"
                            : "npx"}
                      </Badge>
                      <code className="text-[10px] text-muted-foreground">
                        → {e.importPreview.slug}
                      </code>
                    </div>
                    <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {e.kind === "http"
                        ? e.mcpUrl
                        : `${e.command} ${(e.args ?? []).join(" ")}`}
                    </code>
                  </div>
                </label>
              ))}
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <Label>导入后启动</Label>
            <Switch checked={startAfter} onCheckedChange={setStartAfter} />
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy || !vscodeJson.trim()}
              onClick={() => void parseVscode()}
            >
              预览解析
            </Button>
            <Button
              className="flex-1"
              disabled={busy || !vscodeJson.trim()}
              onClick={() => void importVscode()}
            >
              {busy ? "导入中…" : parsed ? "确认导入" : "解析并导入"}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "stdio" ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label>包管理器</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={stdioManager === "npm" ? "default" : "outline"}
                onClick={() => {
                  setStdioManager("npm");
                  setStdioPkg("@modelcontextprotocol/server-filesystem");
                  setStdioExtraArgs("/data");
                }}
              >
                npm / npx
              </Button>
              <Button
                size="sm"
                variant={stdioManager === "pypi" ? "default" : "outline"}
                onClick={() => {
                  setStdioManager("pypi");
                  setStdioPkg("markitdown-mcp");
                  setStdioExtraArgs("");
                }}
              >
                PyPI / uvx
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{stdioManager === "pypi" ? "PyPI 包名" : "npm 包名"}</Label>
            <Input
              value={stdioPkg}
              onChange={(e) => setStdioPkg(e.target.value)}
              placeholder={stdioManager === "pypi" ? "markitdown-mcp" : "@scope/package"}
            />
          </div>

          <div className="space-y-1.5">
            <Label>额外参数（空格分隔，可选）</Label>
            <Input
              value={stdioExtraArgs}
              onChange={(e) => setStdioExtraArgs(e.target.value)}
              placeholder={stdioManager === "npm" ? "/data" : ""}
            />
          </div>

          <div className="space-y-1.5">
            <Label>显示名称（可选）</Label>
            <Input
              value={stdioName}
              onChange={(e) => setStdioName(e.target.value)}
              placeholder="自动取自包名"
            />
          </div>

          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <div className="text-[11px] text-muted-foreground">将执行</div>
            <code className="text-xs">
              {stdioManager === "pypi"
                ? `uvx ${stdioPkg}${stdioExtraArgs.trim() ? ` ${stdioExtraArgs.trim()}` : ""}`
                : `npx -y ${stdioPkg}${stdioExtraArgs.trim() ? ` ${stdioExtraArgs.trim()}` : ""}`}
            </code>
          </div>

          <div className="flex items-center justify-between">
            <Label>导入后启动</Label>
            <Switch checked={startAfter} onCheckedChange={setStartAfter} />
          </div>

          <Button className="w-full" disabled={busy} onClick={() => void importStdio()}>
            {busy ? "创建中…" : "创建 Stdio MCP"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
