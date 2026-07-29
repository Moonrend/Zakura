"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  GitFork,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AgentListItem } from "@/lib/agents";
import {
  SKILL_STORE_LABEL,
  fetchSkillStores,
  listSkillRepos,
  searchSkills,
  syncSkillRepo,
  type SkillRepoSummary,
  type SkillSearchItem,
  type SkillStoreId,
  type SkillStoreMeta,
} from "@/lib/skills";
import { SkillCard, SkillCardSkeleton } from "@/components/skills/skill-card";
import { SkillInstallDialog } from "@/components/skills/skill-install-dialog";

const STORE_ICON: Record<SkillStoreId, typeof Sparkles> = {
  builtin: Sparkles,
  curated: BadgeCheck,
  "skills-sh": Store,
  github: GitFork,
};

const QUICK_QUERIES = [
  "react",
  "testing",
  "deploy",
  "code review",
  "changelog",
  "design",
  "database",
];

const PAGE_SIZE = 24;

function relativeTime(iso: string | null): string {
  if (!iso) return "未同步";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚同步";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前同步`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前同步`;
  return `${Math.round(hours / 24)} 天前同步`;
}

/** 官方仓库货架：服务端已同步到本地，点进去可以逐个浏览 */
function RepoShelf({
  repos,
  onOpen,
  onSynced,
}: {
  repos: SkillRepoSummary[];
  onOpen: (repo: SkillRepoSummary) => void;
  onSynced: () => void;
}) {
  const [syncing, setSyncing] = useState<string | null>(null);

  async function sync(repo: SkillRepoSummary) {
    setSyncing(repo.slug);
    try {
      await syncSkillRepo(repo.slug);
      toast.success(`${repo.name} 已同步`);
      onSynced();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }

  if (!repos.length) return null;
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <BadgeCheck className="size-4 text-primary" />
        <h3 className="text-sm font-medium">官方仓库</h3>
        <span className="text-xs text-muted-foreground">
          由服务端统一同步，安装无需联网
        </span>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {repos.map((repo) => (
          <div
            key={repo.repoKey}
            className="group flex flex-col rounded-xl border border-border bg-card p-3.5 transition-colors hover:border-foreground/20"
          >
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onOpen(repo)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex items-center gap-1.5 truncate text-sm font-medium group-hover:underline">
                  {repo.name}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {repo.slug}
                </span>
              </button>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {repo.publisher}
              </Badge>
            </div>

            <p className="mt-1.5 line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground">
              {repo.description || "—"}
            </p>

            <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              {repo.pending ? (
                <span className="text-warning-foreground">尚未同步</span>
              ) : (
                <>
                  <span>{repo.skillCount} 个技能</span>
                  <span>·</span>
                  <span>{relativeTime(repo.checkedAt)}</span>
                </>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-6"
                title="立即同步"
                disabled={syncing === repo.slug}
                onClick={() => void sync(repo)}
              >
                {syncing === repo.slug ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
            </div>
            {repo.lastError ? (
              <p className="mt-1 truncate text-[11px] text-destructive" title={repo.lastError}>
                {repo.lastError}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkillStorePanel({
  agents,
  stores: storesProp,
  defaultAgentIds,
  onInstalled,
}: {
  agents: AgentListItem[];
  /** 缺省时组件自行拉取商店列表 */
  stores?: SkillStoreMeta[];
  defaultAgentIds?: string[];
  onInstalled?: () => void;
}) {
  const [fetchedStores, setFetchedStores] = useState<SkillStoreMeta[]>([]);
  const stores = storesProp?.length ? storesProp : fetchedStores;
  const [query, setQuery] = useState("");
  const [store, setStore] = useState<SkillStoreId | "all">("all");
  /** 进入某个仓库浏览时的作用域 */
  const [repo, setRepo] = useState<SkillRepoSummary | null>(null);
  const [repos, setRepos] = useState<SkillRepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [items, setItems] = useState<SkillSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [errors, setErrors] = useState<Array<{ store: SkillStoreId; error: string }>>([]);
  const [installSource, setInstallSource] = useState<string | null>(null);
  const [command, setCommand] = useState("");

  const loadRepos = useCallback(() => {
    void listSkillRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await searchSkills(query, store, {
        ...(repo ? { repo: repo.slug } : {}),
        limit: PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setErrors(res.errors);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [query, store, repo]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await searchSkills(query, store, {
        ...(repo ? { repo: repo.slug } : {}),
        offset: items.length,
        limit: PAGE_SIZE,
      });
      setItems((prev) => [...prev, ...res.items]);
      setHasMore(res.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [query, store, repo, items.length]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    if (storesProp?.length) return;
    void fetchSkillStores()
      .then((res) => setFetchedStores(res.stores))
      .catch(() => setFetchedStores([]));
  }, [storesProp]);

  const grouped = useMemo(() => {
    if (store !== "all") return { [store]: items } as Record<string, SkillSearchItem[]>;
    const out: Record<string, SkillSearchItem[]> = {};
    for (const item of items) {
      (out[item.store] ??= []).push(item);
    }
    return out;
  }, [items, store]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const item of items) out[item.store] = (out[item.store] ?? 0) + 1;
    return out;
  }, [items]);

  function openInstall(spec: string) {
    if (!agents.length) {
      toast.error("还没有 Agent，请先创建一个 Agent 再安装技能");
      return;
    }
    setInstallSource(spec);
  }

  async function openRepo(target: SkillRepoSummary) {
    setRepo(target);
    setStore("curated");
    setQuery("");
    if (target.pending) {
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

  const browsing = Boolean(repo);

  return (
    <div className="space-y-5">
      {/* 粘贴安装：npx 命令 / 仓库 / 链接 */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2.5 flex items-center gap-2">
          <Terminal className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">从命令或链接安装</span>
          <span className="text-xs text-muted-foreground">
            支持 npx skills add、owner/repo、GitHub / GitLab 链接、SKILL.md 直链
          </span>
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
            className="shrink-0 self-start"
            disabled={!command.trim()}
            onClick={() => openInstall(command.trim())}
          >
            解析并预览
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>

      {browsing ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setRepo(null)}>
            <ArrowLeft className="size-4" />
            返回商店
          </Button>
          <span className="text-sm font-medium">{repo!.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{repo!.slug}</span>
          <Badge variant="secondary" className="text-[10px]">
            {repo!.skillCount} 个技能
          </Badge>
          {repo!.partial ? (
            <span className="text-[11px] text-muted-foreground">
              仅缓存清单，安装时补齐资源
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <RepoShelf repos={repos} onOpen={(r) => void openRepo(r)} onSynced={loadRepos} />

          {/* 商店切换 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant={store === "all" ? "default" : "outline"}
              onClick={() => setStore("all")}
            >
              全部
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {total || "—"}
              </Badge>
            </Button>
            {stores.map((s) => {
              const Icon = STORE_ICON[s.id] ?? Store;
              return (
                <Button
                  key={s.id}
                  size="sm"
                  variant={store === s.id ? "default" : "outline"}
                  onClick={() => setStore(s.id)}
                  title={s.description}
                >
                  <Icon className="size-3.5" />
                  {s.name}
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    {counts[s.id] ?? 0}
                  </Badge>
                </Button>
              );
            })}
          </div>
        </>
      )}

      {/* 搜索 */}
      <div className="space-y-2">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              browsing ? `在 ${repo!.name} 内搜索…` : "搜索技能，如 react performance、pr review…"
            }
            className="pl-8"
          />
        </div>
        {browsing ? null : (
          <div className="flex flex-wrap gap-1">
            {QUICK_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuery(q)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  query === q
                    ? "border-foreground/30 bg-muted text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60",
                )}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      {errors.length ? (
        <p className="text-xs text-warning-foreground">
          部分商店暂不可用：
          {errors.map((e) => `${SKILL_STORE_LABEL[e.store] ?? e.store}（${e.error}）`).join("，")}
        </p>
      ) : null}

      {/* 结果 */}
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkillCardSkeleton key={i} />
          ))}
        </div>
      ) : !items.length ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {query ? `没有找到「${query}」相关的技能` : "这里还没有技能"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            换个关键词，或直接在上方粘贴仓库地址安装
          </p>
        </div>
      ) : store === "all" && !browsing ? (
        <div className="space-y-6">
          {(Object.keys(grouped) as SkillStoreId[]).map((id) => (
            <section key={id} className="space-y-2.5">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{SKILL_STORE_LABEL[id] ?? id}</h3>
                <span className="text-xs text-muted-foreground">{grouped[id]!.length} 个</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {grouped[id]!.map((item) => (
                  <SkillCard
                    key={item.id}
                    item={item}
                    onPreview={() => openInstall(item.installSpec)}
                    onInstall={() => openInstall(item.installSpec)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <SkillCard
              key={item.id}
              item={item}
              onPreview={() => openInstall(item.installSpec)}
              onInstall={() => openInstall(item.installSpec)}
            />
          ))}
        </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            加载更多（还有 {Math.max(total - items.length, 0)} 个）
          </Button>
        </div>
      ) : null}

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
