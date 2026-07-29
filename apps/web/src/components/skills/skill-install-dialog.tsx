"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  Check,
  FileText,
  Loader2,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SkillMarkdown } from "@/components/skills/skill-markdown";
import { cn } from "@/lib/utils";
import type { AgentListItem } from "@/lib/agents";
import {
  formatBytes,
  installSkill,
  resolveSkillSource,
  type SkillResolveResult,
} from "@/lib/skills";

type ResolvedSkill = SkillResolveResult["skills"][number];

export function SkillInstallDialog({
  open,
  onOpenChange,
  source,
  agents,
  defaultAgentIds,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 安装串：owner/repo@skill、URL、builtin:x 或整条 npx 命令 */
  source: string;
  agents: AgentListItem[];
  defaultAgentIds?: string[];
  onInstalled?: (installedNames: string[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<SkillResolveResult | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [targetAgents, setTargetAgents] = useState<string[]>([]);
  /** 默认装给所有 Agent：技能是能力补充，绝大多数场景就是希望全员可用 */
  const [allAgents, setAllAgents] = useState(true);

  const load = useCallback(async () => {
    if (!source.trim()) return;
    setLoading(true);
    setError(null);
    setResolved(null);
    try {
      const res = await resolveSkillSource(source);
      setResolved(res);
      const names = res.skills.map((s) => s.name);
      setSelectedSkills(names);
      setActiveSkill(names[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (!open) return;
    // 显式传入目标（从某个 Agent 的技能页进来）时按传入的来，否则默认全选
    setTargetAgents(defaultAgentIds ?? []);
    setAllAgents(!defaultAgentIds?.length);
    void load();
    // defaultAgentIds/agents 变化不应重新解析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  const active: ResolvedSkill | null = useMemo(() => {
    if (!resolved?.skills.length) return null;
    return resolved.skills.find((s) => s.name === activeSkill) ?? resolved.skills[0]!;
  }, [resolved, activeSkill]);

  const targetCount = allAgents ? agents.length : targetAgents.length;
  const canInstall =
    !loading && !installing && selectedSkills.length > 0 && targetCount > 0;

  async function install() {
    if (!canInstall) return;
    setInstalling(true);
    try {
      const res = await installSkill({
        source,
        names: selectedSkills,
        ...(allAgents ? { all: true } : { agentIds: targetAgents }),
      });
      const names = res.skills.map((s) => s.name);
      const failed = res.installs.filter((i) => i.status === "error");
      if (failed.length) {
        toast.warning(
          `部分安装失败：${failed.map((f) => f.name).join("、")}`,
          { description: res.warnings[0] },
        );
      } else {
        toast.success(
          `已安装 ${names.join("、")} 到 ${targetCount} 个 Agent`,
          res.warnings.length ? { description: res.warnings[0] } : undefined,
        );
      }
      onInstalled?.(names);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  function toggleSkill(name: string) {
    setSelectedSkills((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function toggleAgent(id: string) {
    setTargetAgents((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
    setAllAgents(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(84vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border px-5 py-3.5">
          <DialogTitle className="text-base">安装技能</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {source}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在解析来源…
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <AlertTriangle className="size-6 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : resolved ? (
          <div className="flex min-h-0 flex-1">
            {/* 左：技能列表 + 目标 Agent */}
            <div className="flex w-64 shrink-0 flex-col border-r border-border">
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-1 p-2.5">
                  <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    找到 {resolved.skills.length} 个技能
                  </p>
                  {resolved.skills.map((skill) => (
                    <div
                      key={skill.name}
                      className={cn(
                        "flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors",
                        active?.name === skill.name ? "bg-muted" : "hover:bg-muted/60",
                      )}
                    >
                      <Checkbox
                        checked={selectedSkills.includes(skill.name)}
                        onCheckedChange={() => toggleSkill(skill.name)}
                        className="mt-0.5"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setActiveSkill(skill.name)}
                      >
                        <span className="flex items-center gap-1 truncate text-xs font-medium">
                          {skill.name}
                          {skill.installed ? (
                            <Badge variant="secondary" className="text-[9px]">
                              已注册
                            </Badge>
                          ) : null}
                        </span>
                        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                          {skill.description}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="border-t border-border p-2.5">
                <div className="flex items-center gap-1.5 px-1 pb-1.5">
                  <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    安装到
                  </p>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {allAgents ? `全部 ${agents.length}` : `已选 ${targetAgents.length}`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAllAgents(true);
                    setTargetAgents([]);
                  }}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                    allAgents
                      ? "bg-primary/10 font-medium text-primary"
                      : "hover:bg-muted/60",
                  )}
                >
                  <Users className="size-3.5" />
                  <span className="flex-1 text-left">所有 Agent（{agents.length}）</span>
                  {allAgents ? <Check className="size-3.5" /> : null}
                </button>
                <ScrollArea className="max-h-40">
                  <div className="space-y-0.5">
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => toggleAgent(agent.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                          targetAgents.includes(agent.id)
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-muted/60",
                          allAgents && "opacity-50",
                        )}
                      >
                        <Bot className="size-3.5 shrink-0" />
                        <span className="flex-1 truncate text-left">{agent.name}</span>
                        {targetAgents.includes(agent.id) ? (
                          <Check className="size-3.5 shrink-0" />
                        ) : null}
                      </button>
                    ))}
                    {!agents.length ? (
                      <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                        还没有 Agent
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
            </div>

            {/* 右：SKILL.md 预览 */}
            <div className="flex min-w-0 flex-1 flex-col">
              {active ? (
                <>
                  <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
                    <FileText className="size-3.5 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">
                      {active.name}/SKILL.md
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {active.files.length} 个文件 · {formatBytes(active.sizeBytes)}
                    </span>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="px-5 py-4">
                      <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3">
                        <p className="text-xs leading-5 text-muted-foreground">
                          {active.description}
                        </p>
                      </div>
                      <SkillMarkdown content={active.body} />
                      {active.files.length > 1 ? (
                        <div className="mt-6 border-t border-border pt-3">
                          <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                            捆绑文件
                          </p>
                          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                            {active.files
                              .filter((f) => f.path !== "SKILL.md")
                              .map((f) => (
                                <li key={f.path}>
                                  {f.path}
                                  <span className="ml-2 opacity-60">
                                    {formatBytes(f.size)}
                                  </span>
                                </li>
                              ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </ScrollArea>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter className="border-t border-border px-5 py-3">
          <div className="mr-auto flex flex-col gap-0.5 text-xs text-muted-foreground">
            {resolved?.warnings.length ? (
              <span className="flex items-center gap-1 text-warning-foreground">
                <AlertTriangle className="size-3" />
                {resolved.warnings[0]}
              </span>
            ) : null}
            <span>
              将安装 {selectedSkills.length} 个技能到 {targetCount} 个 Agent 的
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">/skills</code>
              目录
            </span>
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canInstall} onClick={() => void install()}>
            {installing ? <Loader2 className="size-4 animate-spin" /> : null}
            安装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillLabel({ children }: { children: React.ReactNode }) {
  return <Label className="text-xs text-muted-foreground">{children}</Label>;
}
