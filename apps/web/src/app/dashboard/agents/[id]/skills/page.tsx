"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  FileText,
  FolderPlus,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
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
import { PageLoading } from "@/components/ui/progress-linear";
import {
  installToAgent,
  listAgentSkills,
  parseSkillBody,
  readAgentSkillFile,
  setAgentSkillEnabled,
  uninstallAgentSkill,
  type AgentSkillRecord,
} from "@/lib/skills";
import { SkillMarkdown } from "@/components/skills/skill-markdown";

export default function AgentSkillsPage() {
  const { confirm } = useConfirmDialog();
  const { id, agent } = useAgentDetail();
  const [skills, setSkills] = useState<AgentSkillRecord[]>([]);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const [filter, setFilter] = useState("");

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
    if (
      !(await confirm({
        title: `卸载 ${skill.name}？`,
        confirmLabel: "卸载",
      }))
    )
      return;
    setBusy(skill.name);
    try {
      await uninstallAgentSkill(id, skill.name);
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

  const q = filter.trim().toLowerCase();
  const visible = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;
  const enabled = skills.filter((s) => s.enabled).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
            技能
          </h1>
          {skills.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {enabled}/{skills.length} 启用
            </p>
          )}
        </div>
        <Button
          size="sm"
          nativeButton={false}
          render={<Link href={`/dashboard/agents/${id}/skills/add`} />}
        >
          <Plus className="size-3.5" />
          添加
        </Button>
      </div>

      {unregistered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <FolderPlus className="size-3.5 shrink-0" />
          <span>未登记</span>
          {unregistered.map((name) => (
            <button
              key={name}
              type="button"
              disabled={busy === name}
              onClick={() => void registerWorkspaceSkill(name)}
              className="rounded-md border border-border px-2 py-0.5 text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy === name && (
                <Loader2 className="mr-1 inline size-3 animate-spin" />
              )}
              {name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <PageLoading />
      ) : skills.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {agent?.name ?? "该 Agent"} 还没有安装技能
        </p>
      ) : (
        <div className="space-y-2">
          {skills.length > 6 && (
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选"
                className="h-8 pl-7 text-xs"
              />
            </div>
          )}

          <div className="divide-y divide-border border-y border-border">
            {visible.map((skill) => (
              <div
                key={skill.id}
                className={cn(
                  "group flex items-center gap-3 py-2.5 transition-colors",
                  !skill.enabled && "opacity-40",
                )}
              >
                <button
                  type="button"
                  onClick={() => void openPreview(skill)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium group-hover:underline">
                      {skill.name}
                    </span>
                    {skill.builtin && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        内置
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skill.status === "error"
                      ? skill.error ?? "安装失败"
                      : skill.description}
                  </span>
                </button>

                <Switch
                  checked={skill.enabled}
                  disabled={busy === skill.name}
                  onCheckedChange={(v) => void toggle(skill, v)}
                />
                <button
                  type="button"
                  title="查看"
                  onClick={() => void openPreview(skill)}
                  className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
                >
                  <FileText className="size-3.5" />
                </button>
                <button
                  type="button"
                  title="卸载"
                  disabled={busy === skill.name}
                  onClick={() => void remove(skill)}
                  className="shrink-0 p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          {q && visible.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              没有匹配「{filter}」的技能
            </p>
          )}
        </div>
      )}

      {/* SKILL.md 预览 */}
      <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <DialogContent
          className={cn(
            "flex flex-col gap-0 overflow-hidden p-0",
            "h-[100dvh] max-h-[100dvh] max-w-full rounded-none",
            "sm:h-[min(84vh,700px)] sm:max-h-[84vh] sm:max-w-2xl sm:rounded-xl",
          )}
        >
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 sm:px-5">
            <DialogTitle className="truncate text-base">
              {preview?.name}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">
              SKILL.md
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-4 py-4 sm:px-6">
              <SkillMarkdown content={preview?.content ?? ""} />
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
