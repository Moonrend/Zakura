"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderKanban, FolderOpen, Loader2, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  updateAgentProject,
  type AgentProject,
} from "@/lib/agent-fs";
import { ProjectConfigPanel } from "./project-config-panel";
import { PresenceAvatars } from "./presence-avatars";
import type { PresenceLocation } from "@zakura/shared";
import { cn } from "@/lib/utils";

export function ProjectListPane({
  projects,
  sessionCountBySlug,
  onOpen,
  onSettings,
  onCreate,
  peersByProject,
  onPickUser,
}: {
  projects: AgentProject[];
  sessionCountBySlug: Map<string, number>;
  onOpen: (slug: string) => void;
  onSettings: (slug: string) => void;
  onCreate: () => void;
  peersByProject?: Map<string, PresenceLocation[]>;
  onPickUser?: (userId: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-4 py-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-sm font-medium">项目</h1>
          <p className="text-xs text-muted-foreground">
            用来分组对话和写说明，工作区目录是可选的。
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          新建
        </Button>
      </div>
      {projects.length === 0 ? (
        <button
          type="button"
          onClick={onCreate}
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 px-4 py-10 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
        >
          <FolderKanban className="h-5 w-5" />
          <span className="text-sm">还没有项目，点此创建</span>
        </button>
      ) : (
        projects.map((p) => {
          const count = sessionCountBySlug.get(p.slug) ?? 0;
          return (
            <div
              key={p.slug}
              className="group flex items-center gap-1 rounded-lg hover:bg-muted/40"
            >
              <button
                type="button"
                onClick={() => onOpen(p.slug)}
                className="flex min-w-0 flex-1 flex-col items-start px-3 py-2.5 text-left"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {count} 条对话
                  </span>
                  <PresenceAvatars
                    peers={peersByProject?.get(p.slug) ?? []}
                    onPick={onPickUser}
                    className="ml-auto"
                  />
                </span>
                {p.description ? (
                  <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {p.description}
                  </span>
                ) : p.slug !== p.name ? (
                  <span className="mt-0.5 text-[11px] text-muted-foreground">{p.slug}</span>
                ) : null}
              </button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="项目设置"
                className="mr-1 text-muted-foreground hover:text-foreground max-md:opacity-70 md:opacity-0 md:group-hover:opacity-100"
                onClick={() => onSettings(p.slug)}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
}

export function ProjectSettingsPane({
  agentId,
  project,
  onSaved,
  onOpenDir,
  onDelete,
  className,
}: {
  agentId: string;
  project: AgentProject;
  onSaved: (project: AgentProject) => void;
  onOpenDir?: (slug: string) => void;
  onDelete?: (slug: string) => void;
  className?: string;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [saving, setSaving] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setInstructions(project.instructions);
  }, [project.slug, project.name, project.description, project.instructions]);

  async function save() {
    setSaving(true);
    try {
      const res = await updateAgentProject(agentId, project.slug, {
        name: name.trim() || project.slug,
        description,
        instructions,
      });
      onSaved(res.project);
      toast.success("已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function createWorkspace() {
    setCreatingDir(true);
    try {
      const res = await updateAgentProject(agentId, project.slug, { withWorkspace: true });
      onSaved(res.project);
      toast.success("已创建工作区目录");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDir(false);
    }
  }

  return (
    <div className={cn("mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6", className)}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="proj-name">名称</Label>
          <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
          {project.slug !== name.trim() ? (
            <p className="text-[11px] text-muted-foreground">标识：{project.slug}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proj-desc">说明</Label>
          <Input
            id="proj-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个项目是做什么的"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proj-inst">对话指令</Label>
          <Textarea
            id="proj-inst"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="会叠加进这个项目下每段对话的系统提示，不必先有目录。"
            className="min-h-28"
          />
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t border-border/40 pt-4">
        <div className="text-sm font-medium">工作区目录</div>
        {project.hasWorkspace ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-muted-foreground">{project.path}</span>
            {onOpenDir ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onOpenDir(project.slug)}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                打开
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              项目可以没有目录。需要 Agent 读写文件时再创建 /workspace/projects/{project.slug}。
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void createWorkspace()}
              disabled={creatingDir}
            >
              {creatingDir ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              创建工作区目录
            </Button>
          </div>
        )}
      </div>

      {project.hasWorkspace ? (
        <div className="space-y-2 border-t border-border/40 pt-4">
          <div className="text-sm font-medium">目录内配置</div>
          <p className="text-xs text-muted-foreground">
            AGENTS.md、技能和 hooks 仍写在工作区里，与上面的对话指令相互独立。
          </p>
          <ProjectConfigPanel agentId={agentId} slug={project.slug} />
        </div>
      ) : null}

      {onDelete ? (
        <div className="border-t border-border/40 pt-4">
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(project.slug)}>
            删除项目
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function NewProjectFields({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  gitUrl,
  onGitUrlChange,
  withWorkspace,
  onWithWorkspaceChange,
}: {
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  gitUrl: string;
  onGitUrlChange: (v: string) => void;
  withWorkspace: boolean;
  onWithWorkspaceChange: (v: boolean) => void;
}) {
  const wantDir = withWorkspace || Boolean(gitUrl.trim());
  return (
    <div className="space-y-2 py-1">
      <Label htmlFor="np-name">名称</Label>
      <Input
        id="np-name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="my-app"
      />
      <Label htmlFor="np-desc">说明（可选）</Label>
      <Input
        id="np-desc"
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="这个项目是做什么的"
      />
      <label className="flex items-center gap-2 pt-1 text-sm">
        <Checkbox
          checked={wantDir}
          onCheckedChange={(v) => {
            const on = Boolean(v);
            onWithWorkspaceChange(on);
            if (!on) onGitUrlChange("");
          }}
        />
        同时创建工作区目录
      </label>
      {wantDir ? (
        <>
          <Label htmlFor="np-git">Git 地址（可选）</Label>
          <Input
            id="np-git"
            value={gitUrl}
            onChange={(e) => onGitUrlChange(e.target.value)}
            placeholder="https://github.com/org/repo.git"
          />
          <p className="text-[11px] text-muted-foreground">
            目录为 /workspace/projects/{name.trim() || "名称"}；填写 Git 则克隆进去。
          </p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          只创建项目分组和说明，不占用工作区。需要文件时再在设置里补目录。
        </p>
      )}
    </div>
  );
}
