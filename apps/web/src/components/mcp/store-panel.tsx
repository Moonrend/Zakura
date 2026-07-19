"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, Store } from "lucide-react";
import { api } from "@/lib/api";
import { McpServerCard } from "@/components/mcp/server-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StoreId = "github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp";

type InstallPreview = {
  id: string;
  kind: "http" | "stdio-npm" | "stdio-pypi" | "stdio-oci" | "stdio-other";
  label: string;
  summary: string;
  detail?: string;
  prefer: "http" | "stdio";
  packageIndex?: number;
  remoteUrl?: string;
  envHints?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }>;
};

type StoreServer = {
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: { url?: string };
  remotes?: Array<{ type: string; url: string }>;
  packages?: Array<{
    registryType: string;
    identifier: string;
    runtimeHint?: string;
    version?: string;
    environmentVariables?: InstallPreview["envHints"];
  }>;
  installKinds: string[];
  storeId: StoreId;
  stars?: number;
  topics?: string[];
  category?: string;
  installHint?: string;
  preview?: InstallPreview[];
};

type Source = {
  id: StoreId;
  name: string;
  url: string;
  description: string;
  syncable: boolean;
};

const STORE_LABEL: Record<StoreId, string> = {
  "github-mcp": "GitHub MCP",
  "official-registry": "Official",
  "mcpservers-org": "中文站",
  "awesome-mcp": "Awesome",
};

const KIND_BADGE: Record<string, string> = {
  http: "HTTP",
  "stdio-npm": "npm",
  "stdio-pypi": "uvx",
  "stdio-oci": "OCI / Docker",
  "stdio-other": "Stdio",
};

export function McpStorePanel() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "http" | "stdio">("all");
  const [store, setStore] = useState<StoreId | "all">("github-mcp");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState<StoreServer[]>([]);
  const [total, setTotal] = useState(0);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [storeCounts, setStoreCounts] = useState<Record<string, number>>({});
  const [installTarget, setInstallTarget] = useState<StoreServer | null>(null);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{
        total: number;
        items: StoreServer[];
        fetchedAt: string | null;
        sources: Source[];
        storeCounts: Record<string, number>;
      }>(
        `/api/mcp/store/search?q=${encodeURIComponent(q)}&kind=${kind}&store=${store}&limit=48`,
      );
      setItems(res.items);
      setTotal(res.total);
      setFetchedAt(res.fetchedAt);
      setSources(res.sources);
      setStoreCounts(res.storeCounts ?? {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [q, kind, store]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const previewOptions = useMemo(
    () => installTarget?.preview ?? [],
    [installTarget],
  );

  const selectedOption = useMemo(
    () => previewOptions.find((p) => p.id === selectedPreviewId) ?? previewOptions[0],
    [previewOptions, selectedPreviewId],
  );

  async function sync(force = false) {
    setSyncing(true);
    try {
      const body =
        store === "all"
          ? { force, maxPages: 25 }
          : { force, store, maxPages: 25 };
      const res = await api<{
        results: Array<{
          storeId: string;
          count: number;
          fromCache: boolean;
          error?: string;
        }>;
      }>("/api/mcp/store/sync", {
        method: "POST",
        json: body,
      });
      const ok = res.results.filter((r) => !r.error);
      const fail = res.results.filter((r) => r.error);
      toast.success(
        `已同步 ${ok.map((r) => `${STORE_LABEL[r.storeId as StoreId] ?? r.storeId} ${r.count}`).join(" · ")}`,
      );
      if (fail.length) {
        toast.error(fail.map((r) => `${r.storeId}: ${r.error}`).join("; "));
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function openInstall(server: StoreServer) {
    try {
      const enriched = await api<StoreServer & { preview?: InstallPreview[] }>(
        `/api/mcp/store/servers/${encodeURIComponent(server.name)}?store=${server.storeId}`,
      );
      const options = enriched.preview?.length
        ? enriched.preview
        : [];
      const preferred =
        options.find((o) => o.kind === "http") ??
        options.find((o) => o.kind === "stdio-npm") ??
        options.find((o) => o.kind === "stdio-pypi") ??
        options.find((o) => o.kind === "stdio-oci") ??
        options[0];
      setSelectedPreviewId(preferred?.id ?? null);
      const env: Record<string, string> = {};
      for (const hint of preferred?.envHints ?? []) {
        env[hint.name] = hint.default ?? "";
      }
      setEnvValues(env);
      setInstallTarget({ ...enriched, preview: options });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setInstallTarget(server);
    }
  }

  function selectOption(opt: InstallPreview) {
    setSelectedPreviewId(opt.id);
    const env: Record<string, string> = {};
    for (const hint of opt.envHints ?? []) {
      env[hint.name] = envValues[hint.name] ?? hint.default ?? "";
    }
    setEnvValues(env);
  }

  async function confirmInstall() {
    if (!installTarget || !selectedOption) return;
    setBusy(true);
    try {
      const res = await api<{
        instance: { id: string; slug: string };
        started: boolean;
        startError?: string;
        authRequired?: boolean;
      }>("/api/mcp/store/install", {
        method: "POST",
        json: {
          name: installTarget.name,
          store: installTarget.storeId,
          prefer: selectedOption.prefer,
          remoteUrl: selectedOption.remoteUrl,
          packageIndex: selectedOption.packageIndex,
          env: envValues,
          start: true,
        },
      });
      if (res.authRequired) {
        toast.message("已安装，上游需要 OAuth 授权");
        setInstallTarget(null);
        router.push(`/dashboard/mcp/${res.instance.id}?oauth=1`);
        return;
      }
      toast.success(
        res.started
          ? `已安装 ${res.instance.slug}`
          : `已创建（启动失败：${res.startError ?? "unknown"}）`,
      );
      setInstallTarget(null);
      router.push(`/dashboard/mcp/${res.instance.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const envHints = selectedOption?.envHints ?? [];
  const activeSource = sources.find((s) => s.id === store);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button variant="outline" disabled={syncing} onClick={() => void sync(true)}>
          <RefreshCw className={syncing ? "animate-spin" : undefined} />
          {store === "all" ? "同步全部" : "同步当前商店"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={store === "all" ? "default" : "outline"}
          onClick={() => setStore("all")}
        >
          全部
          <Badge variant="secondary" className="ml-1 text-[10px]">
            {Object.values(storeCounts).reduce((a, b) => a + b, 0) || "—"}
          </Badge>
        </Button>
        {sources.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={store === s.id ? "default" : "outline"}
            onClick={() => setStore(s.id)}
            title={s.description}
          >
            <Store className="size-3.5" />
            {s.name}
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {storeCounts[s.id] ?? 0}
            </Badge>
          </Button>
        ))}
      </div>

      {activeSource ? (
        <p className="text-xs text-muted-foreground">
          {activeSource.description}{" "}
          <a
            href={activeSource.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline"
          >
            打开源站
            <ExternalLink className="size-3" />
          </a>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {sources.map((s) => (
            <a
              key={s.id}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg bg-card px-2.5 py-1.5 border border-border hover:bg-muted/60"
            >
              {s.name}
              <ExternalLink className="size-3 opacity-50" />
            </a>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          placeholder="搜索名称 / 描述 / 标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="sm:max-w-sm"
        />
        <div className="flex gap-1">
          {(["all", "http", "stdio"] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? "default" : "outline"}
              onClick={() => setKind(k)}
            >
              {k === "all" ? "全部类型" : k === "http" ? "HTTP" : "Stdio"}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {loading ? "加载中…" : `${total} 条结果`}
        {fetchedAt ? ` · 缓存于 ${new Date(fetchedAt).toLocaleString()}` : null}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-lg" />
            ))
          : items.map((item) => (
              <McpServerCard
                key={`${item.storeId}:${item.name}`}
                server={{
                  id: `${item.storeId}:${item.name}`,
                  title: item.title || item.name.split("/").pop() || item.name,
                  subtitle: item.name,
                  description: item.description,
                  version: item.version,
                  stars: item.stars,
                  repositoryUrl: item.repository?.url,
                  badges: [
                    {
                      label: STORE_LABEL[item.storeId] ?? item.storeId,
                      variant: "default",
                    },
                    ...item.installKinds.slice(0, 3).map((k) => ({
                      label: KIND_BADGE[k] ?? k,
                      variant: "secondary" as const,
                    })),
                  ],
                }}
                onInstall={() => void openInstall(item)}
              />
            ))}
      </div>

      {!loading && !items.length ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          暂无结果。点击「同步当前商店」拉取目录，或{" "}
          <Link href="/dashboard/mcp/import" className="underline">
            手动导入
          </Link>
          。
        </div>
      ) : null}

      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>安装预览</DialogTitle>
            <DialogDescription>
              {installTarget?.title || installTarget?.name}
              {installTarget ? (
                <span className="mt-1 block text-[11px]">
                  来源：{STORE_LABEL[installTarget.storeId]} · {installTarget.name}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {previewOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无安装元数据。可到{" "}
                <Link href="/dashboard/mcp/import" className="underline">
                  手动导入
                </Link>{" "}
                粘贴 VS Code JSON 或填写 URL。
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label>安装方案</Label>
                <div className="space-y-1.5">
                  {previewOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => selectOption(opt)}
                      className={`w-full rounded-lg px-3 py-2 text-left ring-1 transition-colors ${
                        selectedOption?.id === opt.id
                          ? "bg-primary/10 ring-primary/40"
                          : "bg-card ring-foreground/10 hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">
                          {opt.label}
                        </Badge>
                        {opt.kind === "stdio-oci" ? (
                          <span className="text-[10px] text-muted-foreground">Docker 运行</span>
                        ) : null}
                      </div>
                      <code className="mt-1 block break-all text-[11px] text-foreground">
                        {opt.summary}
                      </code>
                      {opt.detail ? (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">{opt.detail}</p>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {installTarget?.packages?.length ? (
              <div className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                包信息：
                {installTarget.packages.map((p, i) => (
                  <span key={`${p.identifier}-${i}`} className="mr-2">
                    [{p.registryType}
                    {p.runtimeHint ? `/${p.runtimeHint}` : ""}] {p.identifier}
                    {p.version ? `@${p.version}` : ""}
                  </span>
                ))}
              </div>
            ) : null}

            {envHints.length > 0 ? (
              <div className="space-y-2">
                <Label>环境变量 / 鉴权</Label>
                {envHints.map((h) => (
                  <div key={h.name} className="space-y-1">
                    <div className="text-[11px] text-muted-foreground">
                      {h.name}
                      {h.isRequired ? " *" : ""}
                      {h.description ? ` — ${h.description}` : ""}
                    </div>
                    <Input
                      type={h.isSecret ? "password" : "text"}
                      value={envValues[h.name] ?? ""}
                      onChange={(e) =>
                        setEnvValues((prev) => ({ ...prev, [h.name]: e.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallTarget(null)}>
              取消
            </Button>
            <Button
              disabled={busy || !selectedOption}
              onClick={() => void confirmInstall()}
            >
              {busy ? "安装中…" : "确认安装"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
