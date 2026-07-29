"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
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
  updateSkill,
  type SkillFileContent,
  type SkillRecord,
} from "@/lib/skills";

/** 技能详情弹窗：SKILL.md 全文 + 捆绑文件 + 安装到更多 Agent */
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

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    setLoading(true);
    setActivePath("SKILL.md");
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

  async function toggleAgent(agentId: string, installed: boolean) {
    if (!skill) return;
    setBusyAgent(agentId);
    try {
      if (installed) {
        const { uninstallAgentSkill } = await import("@/lib/skills");
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
      <DialogContent className="flex h-[min(84vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border px-5 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {skill?.builtin ? <Sparkles className="size-4 text-primary" /> : null}
            {skill?.name ?? "技能详情"}
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {skill?.description}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-56 shrink-0 flex-col border-r border-border">
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-0.5 p-2.5">
                  <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    文件
                  </p>
                  {files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => setActivePath(file.path)}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                        activeFile?.path === file.path
                          ? "bg-muted font-medium"
                          : "text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <FileText className="size-3 shrink-0" />
                      <span className="flex-1 truncate font-mono">{file.path}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>

              <div className="border-t border-border p-2.5">
                <p className="px-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  已安装到
                </p>
                <ScrollArea className="max-h-44">
                  <div className="space-y-0.5">
                    {agents.map((agent) => {
                      const installed = skill?.agentIds.includes(agent.id) ?? false;
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          disabled={busyAgent === agent.id}
                          onClick={() => void toggleAgent(agent.id, installed)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
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
                  </div>
                </ScrollArea>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 py-4">
                {isMarkdown ? (
                  <SkillMarkdown content={rendered} />
                ) : (
                  <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
                    {rendered}
                  </pre>
                )}
              </div>
            </ScrollArea>
          </div>
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const agentName = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 6),
    [agents],
  );

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

  async function remove(skill: SkillRecord) {
    if (
      !confirm(
        `删除技能 ${skill.name}？将从 ${skill.agentIds.length} 个 Agent 的工作区一并移除。`,
      )
    ) {
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
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
        <p className="text-sm text-muted-foreground">还没有安装任何技能</p>
        <p className="mt-1 text-xs text-muted-foreground">
          去「技能商店」浏览内置推荐，或粘贴 npx 命令安装
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border">
        {skills.map((skill, index) => (
          <div
            key={skill.id}
            className={cn(
              "flex items-center gap-3 bg-card px-4 py-3 transition-colors hover:bg-muted/40",
              index > 0 && "border-t border-border",
            )}
          >
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70",
                skill.builtin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              <Sparkles className="size-4" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
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
                {skill.version && skill.version !== "builtin" ? (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {skill.version.slice(0, 8)}
                  </span>
                ) : null}
                {skill.updateAvailable ? (
                  <Badge
                    variant="outline"
                    className="border-primary/40 text-[10px] text-primary"
                    title="平台缓存里已有更新版本，点右侧刷新即可更新"
                  >
                    有新版本
                  </Badge>
                ) : null}
              </div>
              <p className="line-clamp-1 text-xs text-muted-foreground">
                {skill.description}
              </p>
            </div>

            <div className="hidden shrink-0 items-center gap-1 sm:flex">
              {skill.agentIds.slice(0, 3).map((id) => (
                <Badge key={id} variant="outline" className="max-w-24 truncate text-[10px]">
                  {agentName(id)}
                </Badge>
              ))}
              {skill.agentIds.length > 3 ? (
                <Badge variant="outline" className="text-[10px]">
                  +{skill.agentIds.length - 3}
                </Badge>
              ) : null}
              {!skill.agentIds.length ? (
                <span className="text-[11px] text-muted-foreground">未安装到任何 Agent</span>
              ) : null}
            </div>

            <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted-foreground lg:block">
              {formatBytes(skill.sizeBytes)}
            </span>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                title="从来源重新拉取并同步到已安装的 Agent"
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
                size="icon"
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
      </div>

      <SkillDetailDialog
        skillId={detailId}
        agents={agents}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        onChanged={onChanged}
      />
    </>
  );
}
