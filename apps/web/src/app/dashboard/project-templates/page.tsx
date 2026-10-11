"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Download, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BlueprintEditor,
  emptyBlueprint,
  ParameterValues,
} from "@/components/project-execution/blueprint-editor";
import { TaskGraph } from "@/components/project-execution/task-graph";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
} from "@/components/project-execution/shared";
import { friendlyError } from "@/lib/project-execution";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  deleteTemplate,
  exportTemplate,
  getRecipes,
  importTemplate,
  instantiateTemplate,
  listTemplates,
  parseBlueprintDocument,
  previewBlueprint,
  saveTemplate,
  templateVersions,
  type BlueprintDefinition,
  type Expansion,
  type ProjectTemplate,
  type Scalar,
  type TemplateVersion,
} from "@/lib/project-workbench";

export default function TemplateLibrary() {
  const router = useRouter();
  const [items, setItems] = useState<ProjectTemplate[]>([]);
  const [recipes, setRecipes] = useState<
    { id: string; definition: BlueprintDefinition }[]
  >([]);
  const [current, setCurrent] = useState<ProjectTemplate>();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [version, setVersion] = useState(1);
  const [draft, setDraft] = useState<BlueprintDefinition>(emptyBlueprint);
  const [editorKey, setEditorKey] = useState(0);
  const [valid, setValid] = useState(true);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [parameters, setParameters] = useState<Record<string, Scalar>>({});
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const reload = useCallback(
    async () => setItems((await listTemplates()).items ?? []),
    [],
  );
  useEffect(() => {
    let active = true;
    void Promise.all([
      listTemplates(),
      getRecipes(),
      fetchSpaces(),
      fetchAgents(),
    ])
      .then(([list, recipes, spaces, agents]) => {
        if (!active) return;
        setItems(list.items ?? []);
        setRecipes(recipes.items ?? []);
        setSpaces(spaces);
        setAgents(agents);
        setSpaceId(spaces[0]?.id ?? "");
      })
      .catch((e) => active && setError(friendlyError(e)));
    return () => {
      active = false;
    };
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  const resetEditor = (definition: BlueprintDefinition) => {
    setDraft(structuredClone(definition));
    setEditorKey((k) => k + 1);
    setValid(true);
    setParameters({});
    setMapping({});
    setExpansion(null);
    setDeleteConfirmed(false);
  };
  const select = async (template: ProjectTemplate) => {
    setCurrent(template);
    setVersion(template.currentVersion);
    resetEditor(template.definition);
    setVersions((await templateVersions(template.id)).items ?? []);
  };
  const selectedVersion = versions.find((item) => item.version === version);
  const dirty = current
    ? JSON.stringify(draft) !==
      JSON.stringify(selectedVersion?.definition ?? current.definition)
    : true;
  const roles = [...new Set(draft.tasks.map((task) => task.agentRole))]
    .filter(Boolean)
    .sort();
  const available = agents.filter(
    (agent) => agent.spaceId === spaceId && agent.config?.runtime !== "acp",
  );
  const inputs = {
    parameters,
    agentMapping: mapping,
    spaceId,
    ...(name.trim() ? { name: name.trim() } : {}),
  };
  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">项目蓝图库</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            版本化目标、参数约束、矩阵任务和验收；实例化为项目草稿后再启动。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(reload)}
          >
            <RefreshCw />
            刷新
          </Button>
          <Link href="/dashboard/project-executions">
            <Button variant="outline">长期项目</Button>
          </Link>
          <Button
            onClick={() => {
              setCurrent(undefined);
              setVersions([]);
              setVersion(1);
              resetEditor(emptyBlueprint());
            }}
          >
            <Plus />
            新建蓝图
          </Button>
        </div>
      </header>
      <ErrorNotice message={error} />
      <div className="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Panel title="已保存蓝图">
            <div className="space-y-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`w-full rounded-lg border p-3 text-left text-sm ${current?.id === item.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                  onClick={() => void act(() => select(item))}
                >
                  <strong>{item.definition.name}</strong>
                  <p className="mt-1 text-xs text-muted-foreground">
                    v{item.currentVersion} · {item.definition.tasks.length}{" "}
                    组任务
                  </p>
                </button>
              ))}
              {!items.length && (
                <p className="text-sm text-muted-foreground">尚未保存蓝图。</p>
              )}
            </div>
          </Panel>
          <Panel title="内置配方">
            <div className="space-y-2">
              {recipes.map((recipe) => (
                <button
                  key={recipe.id}
                  className="w-full rounded-lg border p-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setCurrent(undefined);
                    setVersions([]);
                    resetEditor(recipe.definition);
                  }}
                >
                  {recipe.definition.name}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {recipe.definition.description}
                  </p>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="导入蓝图">
            <Field label="蓝图文档 JSON">
              <Textarea
                rows={5}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </Field>
            <Button
              className="mt-3"
              variant="outline"
              disabled={busy || !importText.trim()}
              onClick={() =>
                void act(async () => {
                  const imported = await importTemplate(
                    parseBlueprintDocument(importText),
                  );
                  await reload();
                  await select(imported);
                  setImportText("");
                })
              }
            >
              验证并导入
            </Button>
          </Panel>
        </aside>
        <main className="space-y-4">
          <Panel
            title={current ? `编辑 ${current.definition.name}` : "新蓝图"}
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || !valid}
                  onClick={() =>
                    void act(async () => {
                      const saved = await saveTemplate(draft, current);
                      await reload();
                      await select(saved);
                    })
                  }
                >
                  <Save />
                  {current ? "保存为新版本" : "保存蓝图"}
                </Button>
                {current && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const document = await exportTemplate(
                          current.id,
                          version,
                        );
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(document, null, 2)], {
                            type: "application/json",
                          }),
                        );
                        const anchor = window.document.createElement("a");
                        anchor.href = url;
                        anchor.download = `zakura-blueprint-${current.id}-v${version}.json`;
                        anchor.click();
                        URL.revokeObjectURL(url);
                      })
                    }
                  >
                    <Download />
                    导出所选版本
                  </Button>
                )}
              </div>
            }
          >
            {current ? (
              <div className="flex flex-wrap items-center gap-3">
                <Field label="不可变蓝图版本">
                  <NativeSelect
                    value={version}
                    disabled={busy}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const item = versions.find((item) => item.version === v);
                      if (item) {
                        setVersion(v);
                        resetEditor(item.definition);
                      }
                    }}
                  >
                    {versions.map((item) => (
                      <option key={item.version} value={item.version}>
                        v{item.version} ·{" "}
                        {new Date(item.createdAt).toLocaleString("zh-CN")}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <span className="text-xs text-muted-foreground">
                  {dirty
                    ? "包含未保存修改；实例化前请保存。"
                    : `已保存 v${version}，修改将创建新版本。`}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                先配置任务和参数，预览展开结果，再保存并实例化。
              </p>
            )}
          </Panel>
          <BlueprintEditor
            key={editorKey}
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setExpansion(null);
            }}
            onValidity={setValid}
          />
          <Panel
            title="参数实例与展开预览"
            description="选择真实空间和执行 Agent。预览不会创建项目、启动任务或调用模型。"
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="实例所属空间">
                <NativeSelect
                  value={spaceId}
                  onChange={(e) => {
                    setSpaceId(e.target.value);
                    setMapping({});
                    setExpansion(null);
                  }}
                >
                  <option value="">选择空间</option>
                  {spaces.map((space) => (
                    <option value={space.id} key={space.id}>
                      {space.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="覆盖实例名称（可选）">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setExpansion(null);
                  }}
                />
              </Field>
            </div>
            <ParameterValues
              definition={draft}
              values={parameters}
              onChange={(value) => {
                setParameters(value);
                setExpansion(null);
              }}
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {roles.map((role) => (
                <Field label={`角色 ${role} 对应 Agent`} key={role}>
                  <NativeSelect
                    value={mapping[role] ?? ""}
                    onChange={(e) => {
                      setMapping({ ...mapping, [role]: e.target.value });
                      setExpansion(null);
                    }}
                  >
                    <option value="">选择此空间 Agent</option>
                    {available.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !valid ||
                  !spaceId ||
                  roles.some((role) => !mapping[role])
                }
                onClick={() =>
                  void act(async () =>
                    setExpansion(await previewBlueprint(draft, inputs)),
                  )
                }
              >
                验证并预览展开
              </Button>
              <Button
                disabled={
                  busy ||
                  !valid ||
                  !current ||
                  dirty ||
                  !spaceId ||
                  roles.some((role) => !mapping[role])
                }
                onClick={() =>
                  void act(async () => {
                    if (!current) return;
                    const created = await instantiateTemplate(
                      current,
                      version,
                      inputs,
                    );
                    router.push(
                      `/dashboard/project-executions/${encodeURIComponent(created.project.id)}`,
                    );
                  })
                }
              >
                实例化为项目草稿
              </Button>
            </div>
            {expansion && (
              <div className="mt-5 space-y-4">
                <p className="text-sm">
                  {expansion.project.name} · 展开 {expansion.instances.length}{" "}
                  项任务 · 条件跳过 {expansion.skipped.length} 项
                </p>
                <TaskGraph analysis={expansion.analysis} />
                <details>
                  <summary className="cursor-pointer text-sm">
                    实例矩阵与跳过结果
                  </summary>
                  <Code
                    value={{
                      instances: expansion.instances,
                      skipped: expansion.skipped,
                    }}
                  />
                </details>
                <details>
                  <summary className="cursor-pointer text-sm">
                    完整展开计划
                  </summary>
                  <Code value={expansion.project} />
                </details>
              </div>
            )}
          </Panel>
          {current && (
            <Panel
              title="删除蓝图"
              description="删除库中的模板；已实例化项目保留各自冻结的计划。"
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={deleteConfirmed}
                  onChange={(e) => setDeleteConfirmed(e.target.checked)}
                />
                确认删除此蓝图及库内版本
              </label>
              <Button
                className="mt-3"
                variant="destructive"
                disabled={busy || !deleteConfirmed}
                onClick={() =>
                  void act(async () => {
                    await deleteTemplate(current);
                    setCurrent(undefined);
                    setVersions([]);
                    resetEditor(emptyBlueprint());
                    await reload();
                  })
                }
              >
                删除蓝图
              </Button>
            </Panel>
          )}
        </main>
      </div>
    </div>
  );
}
