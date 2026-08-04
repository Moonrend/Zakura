"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Loader2,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchField } from "@/components/ui/search-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  addConnectionSource,
  connectionKindLabel,
  deleteConnectionSource,
  listConnectionSources,
  listStorePackages,
  packageCountsLabel,
  type ConnectionSourceMeta,
  type StorePackageCard,
  type StorePackageSection,
} from "@/lib/connections";
import { SkillInstallDialog } from "@/components/skills/skill-install-dialog";

function PackageCardGrid({
  items,
  onOpenMarket,
}: {
  items: StorePackageCard[];
  onOpenMarket?: (marketId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        const counts = packageCountsLabel(item.counts);
        const isHub = item.id.startsWith("market-hub:");
        const href = `/dashboard/connections/store/${encodeURIComponent(item.detailId)}`;
        const body = (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium">{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {isHub ? "市场" : connectionKindLabel(item.kind)}
                </span>
                {item.installed ? (
                  <span className="text-[11px] text-muted-foreground">已安装</span>
                ) : null}
              </div>
              {item.description ? (
                <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.description}
                </p>
              ) : null}
              {!isHub && (counts || item.publisher || item.needsRunner) ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {[counts, item.publisher, item.needsRunner ? "需要 Runner" : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              {isHub ? "打开市场 →" : item.installed ? "管理 →" : "查看详情 →"}
            </div>
          </>
        );
        if (isHub) {
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpenMarket?.(item.source)}
              className="flex flex-col rounded-lg border border-border/70 bg-background p-4 text-left transition-colors hover:bg-muted/40"
            >
              {body}
            </button>
          );
        }
        return (
          <Link
            key={item.id}
            href={href}
            className="flex flex-col rounded-lg border border-border/70 bg-background p-4 transition-colors hover:bg-muted/40"
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}

export function StorePanel({
  source,
  onSourceChange,
}: {
  source: string;
  onSourceChange: (source: string) => void;
}) {
  const { confirm } = useConfirmDialog();
  const [sources, setSources] = useState<ConnectionSourceMeta[]>([]);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<StorePackageSection[]>([]);
  const [sourceLabel, setSourceLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [addMarketOpen, setAddMarketOpen] = useState(false);
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [adding, setAdding] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [skillSource, setSkillSource] = useState("");
  const [skillAgents, setSkillAgents] = useState<AgentListItem[]>([]);
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);

  const activeSource = source || "all";

  const loadSources = useCallback(async () => {
    try {
      const list = await listConnectionSources();
      setSources(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadSearch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listStorePackages({
        q: query,
        source: activeSource,
        limit: 120,
      });
      setSections(
        result.sections?.length
          ? result.sections
          : [{ id: activeSource, name: result.sourceLabel || "结果", items: result.items ?? [] }],
      );
      setSourceLabel(result.sourceLabel ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeSource, query]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    void loadSearch();
  }, [loadSearch]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const activeMeta = sources.find((s) => s.id === activeSource);
  const sourceItems = useMemo(
    () => sources.map((s) => ({ value: s.id, label: s.name })),
    [sources],
  );
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const showSections = activeSource === "all" || sections.length > 1;

  async function onAddMarket() {
    if (!repo.trim()) return;
    setAdding(true);
    try {
      const created = await addConnectionSource(repo.trim());
      toast.success(`已添加 ${created.name}`);
      setAddMarketOpen(false);
      setRepo("");
      await loadSources();
      onSourceChange(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onAddMcp() {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setAdding(true);
    try {
      await api("/api/instances", {
        method: "POST",
        json: {
          providerId: "generic-mcp",
          name: mcpName.trim(),
          config: { mcpUrl: mcpUrl.trim() },
          start: true,
        },
      });
      toast.success("MCP 已添加");
      setAddMcpOpen(false);
      setMcpName("");
      setMcpUrl("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onAddSkill() {
    if (!skillSource.trim()) return;
    setAdding(true);
    try {
      const source = skillSource.trim().replace(/^npx\s+skills?\s+add\s+/i, "");
      setSkillSource(source);
      setAddSkillOpen(false);
      setSkillAgents(await fetchAgents());
      setSkillDialogOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onDeleteSource(item: ConnectionSourceMeta) {
    const ok = await confirm({
      title: `删除源 ${item.name}？`,
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteConnectionSource(item.id);
      toast.success("已删除");
      await loadSources();
      if (activeSource === item.id) onSourceChange("all");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={activeSource}
          onValueChange={(v) => v && onSourceChange(v)}
          items={sourceItems}
        >
          <SelectTrigger className="w-[min(100%,16rem)]">
            <SelectValue placeholder="切换市场" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {sourceItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="sm" variant="outline" />}
          >
            <Plus />
            添加
            <ChevronDown className="opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setAddMcpOpen(true)}>
              添加 MCP（URL）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddSkillOpen(true)}>
              <Terminal />
              从仓库安装技能
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddMarketOpen(true)}>
              添加插件市场源
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {activeMeta?.kind === "custom" ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => void onDeleteSource(activeMeta)}
          >
            <Trash2 />
            删除此源
          </Button>
        ) : null}
      </div>

      {activeMeta?.description || sourceLabel ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {activeMeta?.description || sourceLabel}
        </p>
      ) : null}

      <SearchField
        value={q}
        onValueChange={setQ}
        placeholder={activeSource === "all" ? "模糊搜索全部市场…" : "在此市场中搜索…"}
        className="max-w-md"
      />

      {loading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : totalItems === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">没有匹配结果</p>
      ) : showSections ? (
        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.id} className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-medium">
                    {section.name}
                    {section.totalInSection != null ? (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        {section.totalInSection}
                      </span>
                    ) : null}
                  </h2>
                  {section.description ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                  ) : null}
                </div>
                {activeSource === "all" ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => onSourceChange(section.id)}
                  >
                    查看此市场
                  </button>
                ) : null}
              </div>
              <PackageCardGrid items={section.items} onOpenMarket={onSourceChange} />
            </section>
          ))}
        </div>
      ) : (
        <PackageCardGrid items={sections[0]?.items ?? []} onOpenMarket={onSourceChange} />
      )}

      <Dialog open={addMarketOpen} onOpenChange={setAddMarketOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加插件市场源</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="conn-repo">仓库或 marketplace.json URL</Label>
            <Input
              id="conn-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo 或 https://…/marketplace.json"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMarketOpen(false)}>
              取消
            </Button>
            <Button disabled={adding || !repo.trim()} onClick={() => void onAddMarket()}>
              {adding ? <Loader2 className="animate-spin" /> : null}
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addMcpOpen} onOpenChange={setAddMcpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 MCP</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="mcp-name">名称</Label>
              <Input
                id="mcp-name"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="我的 MCP"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-url">MCP URL</Label>
              <Input
                id="mcp-url"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                placeholder="https://…/mcp"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMcpOpen(false)}>
              取消
            </Button>
            <Button
              disabled={adding || !mcpName.trim() || !mcpUrl.trim()}
              onClick={() => void onAddMcp()}
            >
              {adding ? <Loader2 className="animate-spin" /> : null}
              添加并启动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addSkillOpen} onOpenChange={setAddSkillOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从仓库安装技能</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="skill-src">来源</Label>
            <Textarea
              id="skill-src"
              value={skillSource}
              onChange={(e) => setSkillSource(e.target.value)}
              placeholder={"owner/repo\n或 npx skills add owner/repo@skill"}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddSkillOpen(false)}>
              取消
            </Button>
            <Button
              disabled={adding || !skillSource.trim()}
              onClick={() => void onAddSkill()}
            >
              {adding ? <Loader2 className="animate-spin" /> : null}
              安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SkillInstallDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        source={skillSource}
        agents={skillAgents}
        onInstalled={() => void loadSearch()}
      />
    </div>
  );
}

