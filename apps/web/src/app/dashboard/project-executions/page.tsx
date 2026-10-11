"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, RefreshCw, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getProjects,
  friendlyError,
  type Project,
} from "@/lib/project-execution";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import {
  ErrorNotice,
  NativeSelect,
  Panel,
  Status,
} from "@/components/project-execution/shared";
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [space, setSpace] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProjects(space);
      setProjects(data.items ?? []);
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [space]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void fetchSpaces()
      .then(setSpaces)
      .catch((e) => setError(friendlyError(e)));
  }, []);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FolderKanban className="size-6" />
            长期项目
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            把大型交付拆成可验收任务。Agent
            持续执行，保留检查点与独立产物，成员审核后再合并到原工作区。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/project-templates"
            className="inline-flex h-9 items-center rounded-lg border px-3 text-sm hover:bg-muted"
          >
            蓝图库
          </Link>
          <Link
            href="/dashboard/project-portfolio"
            className="inline-flex h-9 items-center rounded-lg border px-3 text-sm hover:bg-muted"
          >
            组合调度
          </Link>
          <Link
            href="/dashboard/project-executions/new"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-primary-foreground"
          >
            <Plus className="size-4" />
            创建项目
          </Link>
        </div>
      </header>
      <ErrorNotice message={error} />
      <Panel
        title="项目列表"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void reload()}
          >
            <RefreshCw />
            刷新
          </Button>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Input
            aria-label="搜索项目"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索项目名称与目标"
          />
          <NativeSelect
            aria-label="筛选所属空间"
            value={space}
            onChange={(e) => setSpace(e.target.value)}
          >
            <option value="">全部空间</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">正在读取项目…</p>
        ) : projects.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {projects
              .filter((p) =>
                `${p.name} ${p.goal}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((project) => (
                <Link
                  className="rounded-xl border p-4 transition-colors hover:border-primary/50 hover:bg-primary/5"
                  key={project.id}
                  href={`/dashboard/project-executions/${encodeURIComponent(project.id)}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-medium">{project.name}</h2>
                    <Status value={project.status} />
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                    {project.goal}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>
                      {spaces.find((s) => s.id === project.spaceId)?.name ??
                        "所属空间"}
                    </span>
                    <span>{project.plan.tasks.length} 项任务</span>
                    <span>计划 v{project.plan.version}</span>
                    <span>
                      {new Date(project.updatedAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                </Link>
              ))}
          </div>
        ) : (
          <div className="py-10 text-center">
            <p className="font-medium">还没有长期项目</p>
            <p className="mt-2 text-sm text-muted-foreground">
              先定义交付目标、任务依赖与验证条件，再开始一轮持续执行。
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
