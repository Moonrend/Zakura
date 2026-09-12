"use client";

/**
 * Agent 设置 · 项目（对话分组 + 可选工作区）
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderKanban, MoreHorizontal, Trash2 } from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  listAgentProjects,
  deleteAgentProject,
  type AgentProject,
} from "@/lib/agent-fs";
import { ProjectSettingsPane } from "@/components/chat/project-pane";

export default function AgentProjectsPage() {
  const { confirm } = useConfirmDialog();
  const { id, agent, loading } = useAgentDetail();
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentProjects(id)
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects);
        setListError(null);
        setSelected((prev) => prev ?? res.projects[0]?.slug ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setProjects([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleDelete(slug: string) {
    const rec = projects.find((p) => p.slug === slug);
    const ok = await confirm({
      title: `删除项目 ${rec?.name ?? slug}？`,
      description: rec?.hasWorkspace
        ? `将删除项目记录和工作区目录 ${rec.path}。该项目下的对话和定时任务会解绑，不会被删掉。`
        : "将删除项目记录。该项目下的对话和定时任务会解绑，不会被删掉。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentProject(id, slug);
      const next = projects.filter((p) => p.slug !== slug);
      setProjects(next);
      if (selected === slug) setSelected(next[0]?.slug ?? null);
      toast.success("已删除项目");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const current = projects.find((p) => p.slug === selected) ?? null;

  if (loading || !agent) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-4">
      <SettingsHeader title="项目" description="对话分组与说明，工作区目录可选" />
      {listError ? (
        <p className="text-sm text-muted-foreground">{listError}</p>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <FolderKanban className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有项目。在对话主页创建。</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <nav className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
            {projects.map((p) => (
              <div
                key={p.slug}
                className={cn(
                  "group flex items-center rounded-lg",
                  selected === p.slug ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelected(p.slug)}
                  className={cn(
                    "min-w-0 flex-1 px-2.5 py-1.5 text-left text-sm",
                    selected === p.slug
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="block truncate">{p.name}</span>
                  {p.description ? (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {p.description}
                    </span>
                  ) : null}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label="项目操作"
                        className="mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      />
                    }
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-32">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void handleDelete(p.slug)}
                    >
                      <Trash2 />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </nav>
          {current ? (
            <div className="min-w-0">
              <ProjectSettingsPane
                className="mx-0 max-w-none px-0 py-0"
                agentId={id}
                project={current}
                onSaved={(next) => {
                  setProjects((prev) =>
                    prev
                      .map((p) => (p.slug === current.slug ? next : p))
                      .sort((a, b) => a.name.localeCompare(b.name)),
                  );
                  setSelected(next.slug);
                }}
                onDelete={(slug) => void handleDelete(slug)}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
