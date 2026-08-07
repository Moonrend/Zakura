"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  BadgeCheck,
  GitFork,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AgentListItem } from "@/lib/agents";
import {
  DEFAULT_SKILL_STORE,
  SKILL_STORES,
  formatRelative,
  listSkillRepos,
  searchSkills,
  syncSkillRepo,
  type SkillRepoSummary,
  type SkillSearchItem,
  type SkillSearchPage,
  type SkillStoreId,
  type SkillStoreMeta,
} from "@/lib/skills";
import { SkillCard, SkillCardSkeleton } from "@/components/skills/skill-card";
import { SkillInstallDialog } from "@/components/skills/skill-install-dialog";

const STORE_ICON: Record<SkillStoreId, typeof Package> = {
  curated: BadgeCheck,
  builtin: Package,
  "skills-sh": Package,
  github: GitFork,
};

const QUICK_QUERIES = ["react", "testing", "deploy", "code review", "pdf", "design", "database"];

const PAGE_SIZE = 24;

const EMPTY_PAGE: SkillSearchPage = {
  store: DEFAULT_SKILL_STORE,
  items: [],
  total: 0,
  offset: 0,
  limit: PAGE_SIZE,
  hasMore: false,
};

function RepoFilter({
  repos,
  active,
  onSelect,
  onSynced,
}: {
  repos: SkillRepoSummary[];
  active: string | null;
  onSelect: (slug: string | null) => void;
  onSynced: () => void;
}) {
  const [syncing, setSyncing] = useState<string | null>(null);
  const current = repos.find((r) => r.slug === active) ?? null;

  async function sync(slug: string) {
    setSyncing(slug);
    try {
      await syncSkillRepo(slug);
      toast.success(`${slug} 已同步`);
      onSynced();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }

  if (!repos.length) return null;

  return (
    <div className="space-y-1.5">
      <div className="scrollbar-subtle scrollbar-x-compact scrollbar-edge-pad -mx-1 flex snap-x items-center gap-1.5 overflow-x-auto px-1 pb-1">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "shrink-0 snap-start rounded-md border px-2.5 py-1 text-xs transition-colors",
            active === null
              ? "border-foreground/30 bg-muted font-medium text-foreground"
              : "border-border text-muted-foreground hover:bg-muted/60",
          )}
        >
          全部仓库
        </button>
        {repos.map((repo) => (
          <button
            key={repo.repoKey}
            type="button"
            onClick={() => onSelect(repo.slug)}
            title={repo.description || repo.slug}
            className={cn(
              "flex max-w-[min(18rem,72vw)] shrink-0 snap-start items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
              active === repo.slug
                ? "border-foreground/30 bg-muted font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/60",
            )}
          >
            <span className="min-w-0 truncate">{repo.name}</span>
            <span className="shrink-0 tabular-nums opacity-60">
              {repo.pending ? "待同步" : repo.skillCount}
            </span>
          </button>
        ))}
      </div>

      {current ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 max-w-full truncate font-mono" title={current.slug}>
            {current.slug}
          </span>
          <span>·</span>
          <span>{current.pending ? "尚未同步" : `${formatRelative(current.checkedAt)}检查`}</span>
          {current.partial ? <span>· 仅缓存清单，安装时补齐资源</span> : null}
          <Button
            size="xs"
            variant="ghost"
            className="ml-0 sm:ml-auto"
            disabled={syncing === current.slug}
            onClick={() => void sync(current.slug)}
          >
            {syncing === current.slug ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            同步
          </Button>
          {current.lastError ? (
            <p className="w-full truncate text-destructive" title={current.lastError}>
              {current.lastError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SkillStorePanel({
  agents,
  stores: storesProp,
  defaultAgentIds,
  onInstalled,
}: {
  agents: AgentListItem[];
  stores?: SkillStoreMeta[];
  defaultAgentIds?: string[];
  onInstalled?: () => void;
}) {
  const stores = storesProp?.length ? storesProp : SKILL_STORES;
  const [store, setStore] = useState<SkillStoreId>(DEFAULT_SKILL_STORE);
  const [queries, setQueries] = useState<Partial<Record<SkillStoreId, string>>>({});
  const [debounced, setDebounced] = useState("");
  const [repoSlug, setRepoSlug] = useState<string | null>(null);
  const [repos, setRepos] = useState<SkillRepoSummary[]>([]);
  const [page, setPage] = useState<SkillSearchPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installSource, setInstallSource] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const requestId = useRef(0);

  const query = queries[store] ?? "";
  const meta = stores.find((s) => s.id === store);

  const loadRepos = useCallback(() => {
    void listSkillRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await searchSkills(debounced, store, {
        ...(store === "curated" && repoSlug ? { repo: repoSlug } : {}),
        limit: PAGE_SIZE,
      });
      if (id !== requestId.current) return;
      setPage(res);
      if (res.error) {
        toast.error(`${meta?.name ?? store} 暂不可用：${res.error}`);
      }
    } catch (err) {
      if (id !== requestId.current) return;
      setPage({ ...EMPTY_PAGE, store });
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, store, repoSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await searchSkills(debounced, store, {
        ...(store === "curated" && repoSlug ? { repo: repoSlug } : {}),
        offset: page.items.length,
        limit: PAGE_SIZE,
      });
      if (res.store !== store) return;
      setPage((prev) => ({ ...res, items: [...prev.items, ...res.items] }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function switchStore(next: SkillStoreId) {
    if (next === store) return;
    setStore(next);
    setDebounced(queries[next] ?? "");
    if (next !== "curated") setRepoSlug(null);
  }

  function setQuery(value: string) {
    setQueries((prev) => ({ ...prev, [store]: value }));
  }

  function openInstall(spec: string) {
    if (!agents.length) {
      toast.error("还没有 Agent，请先创建一个 Agent 再安装技能");
      return;
    }
    setInstallSource(spec);
  }

  async function selectRepo(slug: string | null) {
    setRepoSlug(slug);
    const target = slug ? repos.find((r) => r.slug === slug) : null;
    if (target?.pending) {
      toast.info(`正在同步 ${target.name}…`);
      try {
        await syncSkillRepo(target.slug);
        loadRepos();
        void load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const shown = page.items.length;
  const showQuickQueries = !query && !repoSlug;
  const repoCounts = useMemo(
    () => repos.reduce((sum, r) => sum + r.skillCount, 0),
    [repos],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
        <div className="mb-2 flex items-center gap-2">
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">从命令或链接安装</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx skills add vercel-labs/agent-skills --skill frontend-design"
            className="min-h-[38px] flex-1 resize-y font-mono text-xs"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (command.trim()) openInstall(command.trim());
              }
            }}
          />
          <Button
            className="shrink-0 sm:self-start"
            disabled={!command.trim()}
            onClick={() => openInstall(command.trim())}
          >
            解析并预览
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="scrollbar-subtle scrollbar-x-compact scrollbar-edge-pad -mx-1 flex snap-x items-center gap-1.5 overflow-x-auto px-1 pb-1">
        {stores.map((s) => {
          const Icon = STORE_ICON[s.id] ?? Package;
          const count = s.id === "curated" ? repoCounts : undefined;
          return (
            <Button
              key={s.id}
              size="sm"
              className="shrink-0 snap-start"
              variant={store === s.id ? "default" : "outline"}
              onClick={() => switchStore(s.id)}
              title={s.description}
            >
              <Icon className="size-3.5" />
              {s.name}
              {store === s.id ? (
                <Badge variant="secondary" className="ml-0.5 text-[10px] tabular-nums">
                  {page.total}
                </Badge>
              ) : count ? (
                <span className="ml-0.5 text-[10px] tabular-nums opacity-60">{count}</span>
              ) : null}
            </Button>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="relative sm:max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={meta?.searchPlaceholder ?? "搜索技能…"}
            className="pl-8"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="清空"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        {store === "curated" ? (
          <RepoFilter
            repos={repos}
            active={repoSlug}
            onSelect={(slug) => void selectRepo(slug)}
            onSynced={loadRepos}
          />
        ) : showQuickQueries ? (
          <div className="flex flex-wrap gap-1">
            {QUICK_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuery(q)}
                className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60"
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {page.direct && page.store === store ? (
        <button
          type="button"
          onClick={() => openInstall(page.direct!.installSpec)}
          className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-left surface-interactive hover:border-foreground/15"
        >
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              直接安装 {page.direct.source}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">预览</span>
        </button>
      ) : null}

      {loading ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkillCardSkeleton key={i} />
          ))}
        </div>
      ) : !shown ? (
        <div className="rounded-lg border border-dashed border-border bg-card/50 p-8 text-center sm:p-10">
          <p className="text-sm text-muted-foreground">
            {page.error
              ? `${meta?.name ?? store} 暂不可用`
              : query
                ? `在${meta?.name ?? "该商店"}没有找到「${query}」`
                : `${meta?.name ?? "该商店"}还没有可安装的技能`}
          </p>
          {page.error ? <p className="mt-1 text-xs text-muted-foreground">{page.error}</p> : null}
        </div>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {page.items.map((item: SkillSearchItem) => (
              <SkillCard
                key={item.id}
                item={item}
                onOpen={() => openInstall(item.installSpec)}
              />
            ))}
          </div>

          <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {shown} / {page.total}
            </span>
            {page.hasMore ? (
              <Button
                size="sm"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
                加载更多
              </Button>
            ) : null}
          </div>
        </>
      )}

      <SkillInstallDialog
        open={Boolean(installSource)}
        onOpenChange={(open) => {
          if (!open) setInstallSource(null);
        }}
        source={installSource ?? ""}
        agents={agents}
        {...(defaultAgentIds ? { defaultAgentIds } : {})}
        onInstalled={() => {
          setCommand("");
          onInstalled?.();
          void load();
        }}
      />
    </div>
  );
}
