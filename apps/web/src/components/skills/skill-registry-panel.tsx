"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpCircle,
  Bot,
  ChevronDown,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SkillMarkdown } from "@/components/skills/skill-markdown";
import { cn } from "@/lib/utils";
import type { AgentListItem } from "@/lib/agents";
import {
  deleteSkill,
  formatBytes,
  getSkill,
  installSkill,
  parseSkillBody,
  uninstallAgentSkill,
  updateSkill,
  type SkillFileContent,
  type SkillRecord,
} from "@/lib/skills";

function SkillDetailDialog({
  skillId,
  agents,
  onOpenChange,
  onChanged,
}: {
  skillId: string | null;
  agents: AgentListItem[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [skill, setSkill] = useState<SkillRecord | null>(null);
  const [files, setFiles] = useState<SkillFileContent[]>([]);
  const [activePath, setActivePath] = useState("SKILL.md");
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [pickingAgents, setPickingAgents] = useState(false);

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    setLoading(true);
    setActivePath("SKILL.md");
    setPickingAgents(false);
    void getSkill(skillId)
      .then((res) => {
        if (cancelled) return;
        setSkill(res.skill);
        setFiles(res.files);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  const activeFile = files.find((f) => f.path === activePath) ?? files[0];
  const isMarkdown = activeFile?.path.endsWith(".md") ?? false;
  const rendered = activeFile
    ? isMarkdown
      ? parseSkillBody(activeFile.content)
      : activeFile.content
    : "";
  const deployed = skill?.agentIds.length ?? 0;

  async function toggleAgent(agentId: string, installed: boolean) {
    if (!skill) return;
    setBusyAgent(agentId);
    try {
      if (installed) {
        await uninstallAgentSkill(agentId, skill.name);
        setSkill({ ...skill, agentIds: skill.agentIds.filter((id) => id !== agentId) });
      } else {
        await installSkill({ skillId: skill.id, agentIds: [agentId] });
        setSkill({ ...skill, agentIds: [...skill.agentIds, agentId] });
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAgent(null);
    }
  }

  return (
    <Dialog open={Boolean(skillId)} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          "h-[100dvh] max-h-[100dvh] max-w-full rounded-none",
          "sm:h-[min(86vh,780px)] sm:max-h-[86vh] sm:max-w-3xl sm:rounded-xl",
        )}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {skill?.builtin ? <Sparkles className="size-4 shrink-0 text-primary" /> : null}
            <span className="truncate">{skill?.name ?? "技能详情"}</span>
            {skill?.builtin ? (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                内置
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="line-clamp-2 text-xs">
            {skill?.description}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {files.length > 1 ? (
              <div className="shrink-0 border-b border-border bg-muted/30">
                <div className="scrollbar-subtle scrollbar-x-compact scrollbar-edge-pad flex snap-x items-center gap-1 overflow-x-auto px-3 py-1.5 sm:px-4">
                  {files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => setActivePath(file.path)}
                      className={cn(
                        "flex max-w-[min(18rem,72vw)] shrink-0 snap-start items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                        activeFile?.path === file.path
                          ? "bg-background font-medium text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <FileText className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">{file.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-4 sm:px-6">
                {isMarkdown ? (
                  <SkillMarkdown content={rendered} />
                ) : (
                  <pre className="scrollbar-subtle scrollbar-x-compact overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
                    {rendered}
                  </pre>
                )}
              </div>
            </ScrollArea>

            <div className="shrink-0 border-t border-border bg-muted/40">
              {pickingAgents ? (
                <ScrollArea className="max-h-40 border-b border-border">
                  <div className="grid gap-1 p-2 sm:grid-cols-2 sm:p-2.5">
                    {agents.map((agent) => {
                      const installed = skill?.agentIds.includes(agent.id) ?? false;
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          disabled={busyAgent === agent.id}
                          onClick={() => void toggleAgent(agent.id, installed)}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                            installed
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:bg-muted/60",
                          )}
                        >
                          {busyAgent === agent.id ? (
                            <Loader2 className="size-3.5 shrink-0 animate-spin" />
                          ) : (
                            <Bot className="size-3.5 shrink-0" />
                          )}
                          <span className="flex-1 truncate text-left">{agent.name}</span>
                          <span className="shrink-0 text-[10px] opacity-70">
                            {installed ? "移除" : "安装"}
                          </span>
                        </button>
                      );
                    })}
                    {!agents.length ? (
                      <p className="px-2 py-3 text-center text-[11px] text-muted-foreground sm:col-span-2">
                        还没有 Agent
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-5">
                <button
                  type="button"
                  onClick={() => setPickingAgents((v) => !v)}
                  className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Users className="size-3.5 shrink-0" />
                  <span className="truncate">
                    已部署到 {deployed} / {agents.length} 个 Agent
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      pickingAgents && "rotate-180",
                    )}
                  />
                </button>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {skill ? `${skill.fileCount} 个文件 · ${formatBytes(skill.sizeBytes)}` : null}
                </span>
                {skill?.homepage ? (
                  <a
                    href={skill.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    来源
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SkillRegistryPanel({
  skills,
  agents,
  loading,
  onChanged,
}: {
  skills: SkillRecord[];
  agents: AgentListItem[];
  loading: boolean;
  onChanged: () => void;
}) {
  const { confirm: askConfirm } = useConfirmDialog();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [filter, setFilter] = useState("");

  const agentName = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 6),
    [agents],
  );

  const outdated = useMemo(() => skills.filter((s) => s.updateAvailable), [skills]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [skills, filter]);

  async function refresh(skill: SkillRecord) {
    setBusy(skill.id);
    try {
      await updateSkill(skill.id);
      toast.success(`${skill.name} 已更新到最新版本`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function updateAll() {
    setUpdatingAll(true);
    const failed: string[] = [];
    for (const skill of outdated) {
      try {
        await updateSkill(skill.id);
      } catch {
        failed.push(skill.name);
      }
    }
    setUpdatingAll(false);
    if (failed.length) toast.warning(`${failed.join("、")} 更新失败`);
    else toast.success(`已更新 ${outdated.length} 个技能`);
    onChanged();
  }

  async function remove(skill: SkillRecord) {
    if (!(await askConfirm({
      title: `删除技能 ${skill.name}？`,
      description: `将从 ${skill.agentIds.length} 个 Agent 的工作区一并移除。`,
      confirmLabel: "删除技能",
    }))) {
      return;
    }
    setBusy(skill.id);
    try {
      await deleteSkill(skill.id);
      toast.success(`已删除 ${skill.name}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    );
  }

  if (!skills.length) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center sm:p-10">
        <p className="text-sm text-muted-foreground">还没有安装任何技能</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选已安装的技能…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {outdated.length ? (
          <Button size="sm" disabled={updatingAll} onClick={() => void updateAll()}>
            {updatingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="size-3.5" />
            )}
            更新 {outdated.length} 个
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        {visible.map((skill, index) => (
          <div
            key={skill.id}
            className={cn(
              "flex items-start gap-2.5 bg-card px-3 py-2.5 transition-colors hover:bg-muted/40 sm:items-center sm:gap-3 sm:px-4 sm:py-3",
              index > 0 && "border-t border-border",
            )}
          >
            <div
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 sm:mt-0",
                skill.builtin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              <Sparkles className="size-4" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <button
                  type="button"
                  onClick={() => setDetailId(skill.id)}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {skill.name}
                </button>
                {skill.builtin ? (
                  <Badge variant="secondary" className="text-[10px]">
                    内置
                  </Badge>
                ) : null}
                {skill.updateAvailable ? (
                  <Badge
                    variant="outline"
                    className="border-primary/40 text-[10px] text-primary"
                  >
                    有新版本
                  </Badge>
                ) : null}
              </div>
              <p className="line-clamp-1 text-xs text-muted-foreground">{skill.description}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground sm:hidden">
                <span>
                  {skill.agentIds.length
                    ? `${skill.agentIds.length} 个 Agent`
                    : "未安装到任何 Agent"}
                </span>
                <span>·</span>
                <span>{formatBytes(skill.sizeBytes)}</span>
              </p>
            </div>

            <div className="hidden shrink-0 items-center gap-1 sm:flex">
              {skill.agentIds.slice(0, 2).map((id) => (
                <Badge key={id} variant="outline" className="max-w-24 truncate text-[10px]">
                  {agentName(id)}
                </Badge>
              ))}
              {skill.agentIds.length > 2 ? (
                <Badge variant="outline" className="text-[10px]">
                  +{skill.agentIds.length - 2}
                </Badge>
              ) : null}
              {!skill.agentIds.length ? (
                <span className="text-[11px] text-muted-foreground">未部署</span>
              ) : null}
            </div>

            <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted-foreground lg:block">
              {formatBytes(skill.sizeBytes)}
            </span>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon-sm"
                variant="ghost"
                title="更新"
                disabled={busy === skill.id}
                onClick={() => void refresh(skill)}
              >
                {busy === skill.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="删除"
                disabled={busy === skill.id}
                onClick={() => void remove(skill)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        {!visible.length ? (
          <p className="bg-card px-4 py-8 text-center text-xs text-muted-foreground">
            没有匹配「{filter}」的技能
          </p>
        ) : null}
      </div>

      <SkillDetailDialog
        skillId={detailId}
        agents={agents}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        onChanged={onChanged}
      />
    </div>
  );
}
