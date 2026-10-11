"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PlanEditor } from "@/components/project-execution/plan-editor";
import { ErrorNotice } from "@/components/project-execution/shared";
import {
  defaultDefinition,
  createProject,
  validateDraft,
  friendlyError,
  type Definition,
} from "@/lib/project-execution";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
export default function CreateProjectPage() {
  const router = useRouter();
  const [value, setValue] = useState<Definition | null>(null);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchSpaces(), fetchAgents()])
      .then(([spaces, agents]) => {
        if (!alive) return;
        setSpaces(spaces);
        setAgents(agents);
        const spaceId =
          spaces.find((s) => s.isDefault)?.id ?? spaces[0]?.id ?? "";
        setValue(
          defaultDefinition(
            spaceId,
            agents.find(
              (a) => a.spaceId === spaceId && a.config?.runtime !== "acp",
            )?.id,
          ),
        );
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async () => {
    if (!value) return;
    const issues = validateDraft(value);
    if (issues.length) {
      setError(issues.join("\n"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(value);
      router.push(
        `/dashboard/project-executions/${encodeURIComponent(project.id)}`,
      );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
      <header>
        <Link
          className="text-sm text-muted-foreground hover:text-foreground"
          href="/dashboard/project-executions"
        >
          ← 项目列表
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">创建长期项目</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          创建只保存计划；进入工作台后可以检查依赖关系并开始执行。
        </p>
      </header>
      <ErrorNotice message={error} />
      {value ? (
        <>
          <PlanEditor
            value={value}
            onChange={setValue}
            spaces={spaces}
            agents={agents}
          />
          <div className="sticky bottom-4 flex justify-end rounded-xl border bg-background/95 p-3 shadow-lg">
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "正在验证并保存…" : "验证并创建项目"}
            </Button>
          </div>
        </>
      ) : (
        !error && (
          <p className="text-sm text-muted-foreground">正在读取空间与 Agent…</p>
        )
      )}
    </div>
  );
}
