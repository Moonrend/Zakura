"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, Store } from "lucide-react";
import { api } from "@/lib/api";
import {
  fromStorePreview,
  pickPreferredInstallPreview,
  type StoreInstallPreview,
  type StoreServerLike,
  type UnifiedMcpConfig,
} from "@/lib/mcp-config";
import { McpServerCard } from "@/components/mcp/server-card";
import { McpInstallDialog } from "@/components/mcp/install-dialog";
import type { McpInstallPhase } from "@/components/mcp/install-flow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type StoreId = "github-mcp" | "official-registry" | "mcpservers-org" | "awesome-mcp";

type StoreServer = StoreServerLike & {
  version: string;
  remotes?: Array<{ type: string; url: string }>;
  packages?: Array<{
    registryType: string;
    identifier: string;
    runtimeHint?: string;
    version?: string;
    environmentVariables?: StoreInstallPreview["envHints"];
  }>;
  installKinds: string[];
  storeId: StoreId;
  stars?: number;
  topics?: string[];
  category?: string;
  installHint?: string;
  preview?: StoreInstallPreview[];
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

/** 单卡安装：状态内聚，互不阻塞其他卡片 */
function StoreServerInstallCard({
  item,
  onInstalled,
}: {
  item: StoreServer;
  onInstalled: (
    instanceId: string,
    meta: { authRequired?: boolean; dialogWasOpen: boolean },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [server, setServer] = useState<StoreServerLike | null>(null);
  const [options, setOptions] = useState<StoreInstallPreview[]>([]);
  const [config, setConfig] = useState<UnifiedMcpConfig | null>(null);
  const [installPhase, setInstallPhase] = useState<McpInstallPhase>("idle");
  const [installedLocal, setInstalledLocal] = useState(false);

  async function openInstall() {
    setOpen(true);
    setLoading(true);
    setConfig(null);
    try {
      const enriched = await api<StoreServer>(
        `/api/mcp/store/servers/${encodeURIComponent(item.name)}?store=${item.storeId}`,
      );
      const opts = enriched.preview?.length ? enriched.preview : [];
      const preferred = pickPreferredInstallPreview(opts) ?? opts[0];
      const like: StoreServerLike = {
        name: enriched.name,
        title: enriched.title,
        description: enriched.description,
        storeId: enriched.storeId,
        repository: enriched.repository,
        preview: opts,
      };
      setServer(like);
      setOptions(opts);
      if (preferred) {
        setConfig(fromStorePreview(like, preferred));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      const like: StoreServerLike = {
        name: item.name,
        title: item.title,
        description: item.description,
        storeId: item.storeId,
        repository: item.repository,
        preview: item.preview,
      };
      setServer(like);
      setOptions(item.preview ?? []);
      const preferred = pickPreferredInstallPreview(item.preview ?? []);
      if (preferred) setConfig(fromStorePreview(like, preferred));
    } finally {
      setLoading(false);
    }
  }

  function selectPreview(opt: StoreInstallPreview) {
    if (!server) return;
    setConfig(fromStorePreview(server, opt));
  }

  return (
    <>
      <McpServerCard
        server={{
          id: `${item.storeId}:${item.name}`,
          title: item.title || item.name.split("/").pop() || item.name,
          subtitle: item.name,
          description: item.description,
          version: item.version,
          stars: item.stars,
          repositoryUrl: item.repository?.url,
          installed: installedLocal,
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
        installPhase={installPhase}
        installMessage={
          installPhase === "creating"
            ? "正在安装并启动…"
            : installPhase === "awaiting_oauth"
              ? "等待授权窗口…"
              : undefined
        }
        onInstall={() => void openInstall()}
      />
      <McpInstallDialog
        open={open}
        onOpenChange={setOpen}
        config={config}
        previewOptions={options}
        storeServer={server}
        onSelectPreview={selectPreview}
        loading={loading}
        onPhaseChange={setInstallPhase}
        onComplete={(result, meta) => {
          setInstalledLocal(true);
          setInstallPhase("done");
          onInstalled(result.instanceId, {
            authRequired: result.authRequired,
            dialogWasOpen: meta.dialogWasOpen,
          });
        }}
      />
    </>
  );
}

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
          placeholder="搜索…"
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
              <StoreServerInstallCard
                key={`${item.storeId}:${item.name}`}
                item={item}
                onInstalled={(id, meta) => {
                  // 弹窗已关：留在商店页；仍开着才进入详情
                  if (!meta.dialogWasOpen && !meta.authRequired) return;
                  router.push(
                    meta.authRequired
                      ? `/dashboard/mcp/${id}?oauth=1`
                      : `/dashboard/mcp/${id}`,
                  );
                }}
              />
            ))}
      </div>

      {!loading && !items.length ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          暂无结果
        </div>
      ) : null}
    </div>
  );
}
