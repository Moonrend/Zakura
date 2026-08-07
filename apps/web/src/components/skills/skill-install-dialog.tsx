"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FileText,
  Loader2,
} from "lucide-react";
import {
  AgentTargetPicker,
  resolveAgentIds,
  type AgentTargetValue,
} from "@/components/agent-target-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const [agentTarget, setAgentTarget] = useState<AgentTargetValue>({
    all: true,
    agentIds: [],
  });

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
    setAgentTarget({
      all: !defaultAgentIds?.length,
      agentIds: defaultAgentIds ?? [],
    });
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  const active: ResolvedSkill | null = useMemo(() => {
    if (!resolved?.skills.length) return null;
    return resolved.skills.find((s) => s.name === activeSkill) ?? resolved.skills[0]!;
  }, [resolved, activeSkill]);

  const multi = (resolved?.skills.length ?? 0) > 1;
  const targetIds = resolveAgentIds(agentTarget, agents);
  const targetCount = targetIds.length;
  const canInstall =
    !loading &&
    !installing &&
    selectedSkills.length > 0 &&
    agents.length > 0 &&
    targetCount > 0;
  const bundled = active?.files.filter((f) => f.path !== "SKILL.md") ?? [];

  async function install() {
    if (!canInstall) return;
    setInstalling(true);
    try {
      const res = await installSkill({
        source,
        names: selectedSkills,
        ...(agentTarget.all ? { all: true } : { agentIds: targetIds }),
      });
      const names = res.skills.map((s) => s.name);
      const failed = res.installs.filter((i) => i.status === "error");
      if (failed.length) {
        toast.warning(`部分安装失败：${failed.map((f) => f.name).join("、")}`, {
          description: res.warnings[0],
        });
      } else {
        toast.success(
          `已安装 ${names.join("、")} 到 ${agentTarget.all ? "全部" : targetCount} 个 Agent`,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl",
          "max-h-[100dvh] h-[100dvh] max-w-full rounded-none",
          "sm:h-[min(86vh,780px)] sm:max-h-[86vh] sm:max-w-3xl sm:rounded-xl",
        )}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Download className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{active?.name ?? "安装技能"}</span>
            {active?.installed ? (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                已注册
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]">
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
        ) : resolved && active ? (
          <>
            {multi ? (
              <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2 sm:px-5">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>
                    来源含 {resolved.skills.length} 个技能，已选 {selectedSkills.length} 个
                  </span>
                  <button
                    type="button"
                    className="ml-auto hover:text-foreground hover:underline"
                    onClick={() =>
                      setSelectedSkills(
                        selectedSkills.length === resolved.skills.length
                          ? []
                          : resolved.skills.map((s) => s.name),
                      )
                    }
                  >
                    {selectedSkills.length === resolved.skills.length ? "全不选" : "全选"}
                  </button>
                </div>
                <ScrollArea className="max-h-24">
                  <div className="flex flex-wrap gap-1.5">
                    {resolved.skills.map((skill) => {
                      const picked = selectedSkills.includes(skill.name);
                      return (
                        <span
                          key={skill.name}
                          className={cn(
                            "inline-flex items-center overflow-hidden rounded-full border text-[11px] transition-colors",
                            active.name === skill.name
                              ? "border-foreground/40"
                              : "border-border",
                            picked ? "bg-muted text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <button
                            type="button"
                            title={picked ? "取消选择" : "选择安装"}
                            onClick={() => toggleSkill(skill.name)}
                            className="flex size-5 items-center justify-center border-r border-inherit hover:bg-muted/60"
                          >
                            {picked ? (
                              <Check className="size-3" />
                            ) : (
                              <span className="size-2 rounded-full border border-current opacity-40" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setActiveSkill(skill.name)}
                            className="max-w-48 truncate px-2 py-0.5 hover:bg-muted/60"
                            title={skill.description}
                          >
                            {skill.name}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            ) : null}

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-4 sm:px-6">
                <div className="mb-4 space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                  <p className="text-xs leading-5">{active.description}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <FileText className="size-3" />
                      {active.files.length} 个文件 · {formatBytes(active.sizeBytes)}
                    </span>
                    {active.version ? (
                      <span className="font-mono">{active.version.slice(0, 12)}</span>
                    ) : null}
                    {active.license ? <span>{active.license}</span> : null}
                    {active.homepage ? (
                      <a
                        href={active.homepage}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                      >
                        来源
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                </div>

                <SkillMarkdown content={active.body} />

                {bundled.length ? (
                  <div className="mt-6 border-t border-border pt-3">
                    <p className="mb-1.5 text-[11px] text-muted-foreground">
                      捆绑文件（{bundled.length}）
                    </p>
                    <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                      {bundled.map((f) => (
                        <li key={f.path} className="flex gap-2">
                          <span className="truncate">{f.path}</span>
                          <span className="shrink-0 opacity-60">{formatBytes(f.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </>
        ) : null}

        <div className="shrink-0 border-t border-border bg-muted/40">
          {resolved?.warnings.length ? (
            <p className="flex items-start gap-1.5 border-b border-border px-4 py-2 text-[11px] text-warning-foreground sm:px-5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span className="line-clamp-2">{resolved.warnings[0]}</span>
            </p>
          ) : null}

          <div className="space-y-3 px-4 py-3 sm:px-5">
            <AgentTargetPicker
              agents={agents}
              value={agentTarget}
              onChange={setAgentTarget}
              disabled={installing}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button size="sm" disabled={!canInstall} onClick={() => void install()}>
                {installing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {multi && selectedSkills.length > 1
                  ? `安装 ${selectedSkills.length} 个`
                  : active?.installed
                    ? "重新安装"
                    : "安装"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillLabel({ children }: { children: React.ReactNode }) {
  return <Label className="text-xs text-muted-foreground">{children}</Label>;
}
