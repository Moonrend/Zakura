"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  FileText,
  FolderPlus,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  installToAgent,
  listAgentSkills,
  parseSkillBody,
  readAgentSkillFile,
  setAgentSkillEnabled,
  uninstallAgentSkill,
  type AgentSkillRecord,
} from "@/lib/skills";
import { SkillStorePanel } from "@/components/skills/skill-store-panel";
import { SkillMarkdown } from "@/components/skills/skill-markdown";

export default function AgentSkillsPage() {
  const { id, agent } = useAgentDetail();
  const [skills, setSkills] = useState<AgentSkillRecord[]>([]);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAgentSkills(id);
      setSkills(res.skills);
      setUnregistered(res.unregistered);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    void fetchAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [load]);

  async function toggle(skill: AgentSkillRecord, enabled: boolean) {
    setBusy(skill.name);
    try {
      await setAgentSkillEnabled(id, skill.name, enabled);
      setSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? { ...s, enabled } : s)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(skill: AgentSkillRecord) {
    if (!confirm(`从 ${agent?.name ?? "该 Agent"} 卸载技能 ${skill.name}？工作区目录会一并删除。`)) {
      return;
    }
    setBusy(skill.name);
    try {
      await uninstallAgentSkill(id, skill.name);
      toast.success(`已卸载 ${skill.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function registerWorkspaceSkill(name: string) {
    setBusy(name);
    try {
      await installToAgent(id, { workspacePath: `/skills/${name}` });
      toast.success(`已登记 ${name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function openPreview(skill: AgentSkillRecord) {
    try {
      const file = await readAgentSkillFile(id, skill.name);
      setPreview({ name: skill.name, content: parseSkillBody(file.content) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="技能"
        description={`已安装 ${skills.length} 个，其中 ${enabledCount} 个已启用并注入到系统提示`}
        actions={
          <Button size="sm" onClick={() => setBrowsing((v) => !v)}>
            <Plus className="size-4" />
            {browsing ? "收起商店" : "添加技能"}
          </Button>
        }
      />

      {browsing ? (
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <SkillStorePanel
            agents={agents}
            defaultAgentIds={[id]}
            onInstalled={() => {
              setBrowsing(false);
              void load();
            }}
          />
        </div>
      ) : null}

      {unregistered.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 p-3">
          <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            工作区里发现未登记的技能目录：
          </span>
          {unregistered.map((name) => (
            <Button
              key={name}
              size="sm"
              variant="outline"
              disabled={busy === name}
              onClick={() => void registerWorkspaceSkill(name)}
            >
              {busy === name ? <Loader2 className="size-3.5 animate-spin" /> : null}
              登记 {name}
            </Button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/60" />
          ))}
        </div>
      ) : !skills.length ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <Sparkles className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">这个 Agent 还没有安装技能</p>
          <p className="mt-1 text-xs text-muted-foreground">
            点右上角「添加技能」浏览商店，或在技能页面批量安装
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {skills.map((skill, index) => (
            <div
              key={skill.id}
              className={cn(
                "flex items-center gap-3 bg-card px-4 py-3 transition-colors hover:bg-muted/40",
                index > 0 && "border-t border-border",
                !skill.enabled && "opacity-60",
              )}
            >
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70",
                  skill.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : skill.builtin
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {skill.status === "error" ? (
                  <AlertTriangle className="size-4" />
                ) : (
                  <Sparkles className="size-4" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void openPreview(skill)}
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {skill.name}
                  </button>
                  {skill.builtin ? (
                    <Badge variant="secondary" className="text-[10px]">
                      内置
                    </Badge>
                  ) : null}
                </div>
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {skill.status === "error"
                    ? (skill.error ?? "安装失败")
                    : skill.description}
                </p>
              </div>

              <code className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:block">
                {skill.path}
              </code>

              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={skill.enabled}
                  disabled={busy === skill.name}
                  onCheckedChange={(checked) => void toggle(skill, checked)}
                  title={skill.enabled ? "已启用（注入系统提示）" : "已停用"}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  title="查看 SKILL.md"
                  onClick={() => void openPreview(skill)}
                >
                  <FileText className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="卸载"
                  disabled={busy === skill.name}
                  onClick={() => void remove(skill)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="flex h-[min(80vh,680px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b border-border px-5 py-3.5">
            <DialogTitle className="text-base">{preview?.name}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              /skills/{preview?.name}/SKILL.md
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-5 py-4">
              <SkillMarkdown content={preview?.content ?? ""} />
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
