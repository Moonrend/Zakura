"use client";

/**
 * Agent 设置 · 项目配置（AGENTS.md / 技能 / hooks）
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  FolderKanban,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { PageLoading } from "@/components/ui/progress-linear";
import { Input } from "@/components/ui/input";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  listAgentProjects,
  renameAgentProject,
  deleteAgentProject,
  type AgentProject,
} from "@/lib/agent-fs";
import { ProjectConfigPanel } from "@/components/chat/project-config-panel";

export default function AgentProjectsPage() {
  const { confirm } = useConfirmDialog();
  const { id, agent, loading } = useAgentDetail();
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    listAgentProjects(id)
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects);
        setListError(null);
        setSelected((prev) => prev ?? res.projects[0]?.name ?? null);
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

  async function commitRename() {
    const from = renaming;
    const to = renameValue.trim();
    setRenaming(null);
    if (!from || !to || to === from) return;
    try {
      const res = await renameAgentProject(id, from, to);
      setProjects((prev) =>
        prev
          .map((p) => (p.name === from ? res.project : p))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      if (selected === from) setSelected(to);
      toast.success(`已重命名为 ${to}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(slug: string) {
    const ok = await confirm({
      title: `删除项目 ${slug}？`,
      description: `将删除工作区目录 /workspace/projects/${slug} 及其文件。该项目下的对话（含子代理）和定时任务会解绑，不会被删掉。`,
      confirmLabel: "删除目录",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentProject(id, slug);
      const next = projects.filter((p) => p.name !== slug);
      setProjects(next);
      if (selected === slug) setSelected(next[0]?.name ?? null);
      toast.success("已删除项目目录");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function copyPath(p: AgentProject) {
    void navigator.clipboard.writeText(p.path).then(
      () => toast.success("已复制路径"),
      () => toast.error("复制失败"),
    );
  }

  if (loading || !agent) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="项目"
        description="独立工作目录"
      />
      {listError ? (
        <p className="text-sm text-muted-foreground">{listError}。需要开启电脑环境才能读写项目文件。</p>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <FolderKanban className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有项目。在对话侧栏创建或让 Agent 自动创建。</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <nav className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
            {projects.map((p) => (
              <div
                key={p.name}
                className={cn(
                  "group flex items-center rounded-lg",
                  selected === p.name ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                {renaming === p.name ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="h-7 px-2 text-sm"
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setSelected(p.name)}
                      className={cn(
                        "min-w-0 flex-1 px-2.5 py-1.5 text-left text-sm",
                        selected === p.name
                          ? "font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="block truncate">{p.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {p.path}
                      </span>
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
                        <DropdownMenuItem onClick={() => copyPath(p)}>
                          <FolderOpen />
                          复制路径
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setRenaming(p.name);
                            setRenameValue(p.name);
                          }}
                        >
                          <Pencil />
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => void handleDelete(p.name)}
                        >
                          <Trash2 />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            ))}
          </nav>
          {selected ? (
            <div className="min-w-0 rounded-lg border border-border bg-card p-3 sm:p-4">
              <ProjectConfigPanel agentId={id} slug={selected} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
