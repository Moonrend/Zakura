"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SpaceItem } from "@/lib/spaces";
import type { AgentListItem } from "@/lib/agents";
import {
  CHECK_LABELS,
  newTask,
  newCheck,
  type Definition,
  type TaskSpec,
  type CheckSpec,
  type CheckKind,
  type Budget,
} from "@/lib/project-execution";
import { Field, NativeSelect, Panel } from "./shared";

export function PlanEditor({
  value,
  onChange,
  spaces,
  agents,
  lockSpace = false,
}: {
  value: Definition;
  onChange: (value: Definition) => void;
  spaces: SpaceItem[];
  agents: AgentListItem[];
  lockSpace?: boolean;
}) {
  const [selected, setSelected] = useState(value.plan.tasks[0]?.id ?? "");
  const selectedTask =
    value.plan.tasks.find((t) => t.id === selected) ?? value.plan.tasks[0];
  const available = agents.filter(
    (a) => a.spaceId === value.spaceId && a.config?.runtime !== "acp",
  );
  const updateTask = (task: TaskSpec) =>
    onChange({
      ...value,
      plan: {
        ...value.plan,
        tasks: value.plan.tasks.map((t) => (t.id === task.id ? task : t)),
      },
    });
  const addTask = () => {
    const task = newTask(available[0]?.id);
    onChange({
      ...value,
      plan: { ...value.plan, tasks: [...value.plan.tasks, task] },
    });
    setSelected(task.id);
  };
  const removeTask = (id: string) => {
    onChange({
      ...value,
      plan: {
        ...value.plan,
        tasks: value.plan.tasks
          .filter((t) => t.id !== id)
          .map((t) => ({
            ...t,
            dependsOn: t.dependsOn.filter((d) => d !== id),
          })),
      },
    });
    setSelected(value.plan.tasks.find((t) => t.id !== id)?.id ?? "");
  };
  const setBudget = (key: keyof Budget, number: number) =>
    onChange({
      ...value,
      config: {
        ...value.config,
        budget: {
          ...value.config.budget,
          [key]: Number.isFinite(number)
            ? Math.max(key === "maxConcurrent" ? 1 : 0, Math.floor(number))
            : key === "maxConcurrent"
              ? 1
              : 0,
        },
      },
    });
  return (
    <div className="space-y-5">
      <Panel
        title="项目目标"
        description="描述具体产物、成功标准和不在范围内的事项。每轮执行固定计划版本与工作区基线。"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="项目名称">
            <Input
              value={value.name}
              maxLength={200}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="例如：实现订单退款功能"
            />
          </Field>
          <Field label="所属空间">
            <NativeSelect
              value={value.spaceId}
              disabled={lockSpace}
              onChange={(e) =>
                onChange({
                  ...value,
                  spaceId: e.target.value,
                  plan: {
                    ...value.plan,
                    tasks: value.plan.tasks.map((t) => ({ ...t, agentId: "" })),
                  },
                })
              }
            >
              <option value="">选择空间</option>
              {spaces.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="交付目标">
            <Textarea
              rows={4}
              value={value.goal}
              onChange={(e) => onChange({ ...value, goal: e.target.value })}
              placeholder="完成哪些功能，交付哪些文件，如何证明结果满足要求？"
            />
          </Field>
        </div>
      </Panel>
      <Panel
        title="执行预算与审核"
        description="资源预算为 0 表示不设上限；同时执行数至少为 1。实际消耗与预留由服务端记录。"
      >
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {(
            [
              ["maxTokens", "Token 上限"],
              ["maxModelCalls", "模型调用"],
              ["maxToolCalls", "工具调用"],
              ["maxWallSeconds", "最长秒数"],
              ["maxConcurrent", "同时执行数"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                type="number"
                min={key === "maxConcurrent" ? 1 : 0}
                max={key === "maxConcurrent" ? 1000 : undefined}
                value={value.config.budget[key]}
                onChange={(e) => setBudget(key, e.target.valueAsNumber)}
              />
            </Field>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.config.requireReview}
              onChange={(e) =>
                onChange({
                  ...value,
                  config: { ...value.config, requireReview: e.target.checked },
                })
              }
            />
            任务验收后由成员审核
          </label>
          <Field label="外部写操作">
            <NativeSelect
              value={value.config.externalEffects}
              onChange={(e) =>
                onChange({
                  ...value,
                  config: {
                    ...value.config,
                    externalEffects: e.target
                      .value as Definition["config"]["externalEffects"],
                  },
                })
              }
            >
              <option value="deny">禁止</option>
              <option value="review">每次先审核</option>
              <option value="allow">允许执行</option>
            </NativeSelect>
          </Field>
          <Field label="计划版本">
            <Input
              type="number"
              min={1}
              value={value.plan.version}
              onChange={(e) =>
                onChange({
                  ...value,
                  plan: {
                    ...value.plan,
                    version: Math.max(
                      1,
                      Math.floor(e.target.valueAsNumber) || 1,
                    ),
                  },
                })
              }
            />
          </Field>
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Panel
          title="任务图"
          actions={
            <Button size="sm" variant="outline" onClick={addTask}>
              <Plus />
              新增
            </Button>
          }
        >
          <div className="space-y-2">
            {value.plan.tasks.map((task, index) => (
              <button
                type="button"
                key={task.id}
                onClick={() => setSelected(task.id)}
                className={`w-full rounded-lg border p-3 text-left text-sm ${selectedTask?.id === task.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
              >
                <span className="block font-medium">
                  {index + 1}. {task.title || "未命名任务"}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {task.dependsOn.length} 项依赖 ·{" "}
                  {task.checks.filter((c) => c.required).length} 项必需验收
                </span>
              </button>
            ))}
          </div>
        </Panel>
        {selectedTask ? (
          <Panel
            title={selectedTask.title || "编辑任务"}
            actions={
              <Button
                variant="destructive"
                size="sm"
                disabled={value.plan.tasks.length <= 1}
                onClick={() => removeTask(selectedTask.id)}
              >
                <Trash2 />
                删除任务
              </Button>
            }
          >
            <TaskEditor
              key={selectedTask.id}
              task={selectedTask}
              tasks={value.plan.tasks}
              agents={available}
              update={updateTask}
            />
          </Panel>
        ) : (
          <Panel title="任务要求">
            <p className="text-muted-foreground">添加一个任务开始制定计划。</p>
          </Panel>
        )}
      </div>
    </div>
  );
}
function TaskEditor({
  task,
  tasks,
  agents,
  update,
}: {
  task: TaskSpec;
  tasks: TaskSpec[];
  agents: AgentListItem[];
  update: (task: TaskSpec) => void;
}) {
  const set = <K extends keyof TaskSpec>(key: K, value: TaskSpec[K]) =>
    update({ ...task, [key]: value });
  const [writeText, setWriteText] = useState(task.writes.join("\n"));
  const checkUpdate = (check: CheckSpec) =>
    set(
      "checks",
      task.checks.map((c) => (c.id === check.id ? check : c)),
    );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="任务标题">
          <Input
            value={task.title}
            maxLength={500}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <Field
          label="执行 Agent"
          hint="使用当前空间的网关 Agent；ACP 不提供逐步持久化检查点。"
        >
          <NativeSelect
            value={task.agentId}
            onChange={(e) => set("agentId", e.target.value)}
          >
            <option value="">选择 Agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="执行要求">
        <Textarea
          rows={5}
          value={task.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder="给 Agent 的完整任务说明，以及必须复用的依赖产物。"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="模型（留空跟随 Agent）">
          <Input
            value={task.model ?? ""}
            onChange={(e) => set("model", e.target.value)}
          />
        </Field>
        <Field label="优先级">
          <Input
            type="number"
            min={-1000}
            max={1000}
            value={task.priority}
            onChange={(e) =>
              set(
                "priority",
                Math.max(
                  -1000,
                  Math.min(1000, Math.floor(e.target.valueAsNumber) || 0),
                ),
              )
            }
          />
        </Field>
        <Field label="最大尝试次数">
          <Input
            type="number"
            min={1}
            max={100}
            value={task.maxAttempts}
            onChange={(e) =>
              set(
                "maxAttempts",
                Math.max(
                  1,
                  Math.min(100, Math.floor(e.target.valueAsNumber) || 1),
                ),
              )
            }
          />
        </Field>
      </div>
      <fieldset className="rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">必须先完成的任务</legend>
        <div className="flex flex-wrap gap-3">
          {tasks
            .filter((t) => t.id !== task.id)
            .map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={task.dependsOn.includes(t.id)}
                  onChange={(e) =>
                    set(
                      "dependsOn",
                      e.target.checked
                        ? [...task.dependsOn, t.id]
                        : task.dependsOn.filter((id) => id !== t.id),
                    )
                  }
                />
                {t.title || t.id}
              </label>
            ))}
          {tasks.length < 2 && (
            <p className="text-xs text-muted-foreground">
              增加其他任务后可以设置依赖。
            </p>
          )}
        </div>
      </fieldset>
      <Field
        label="写入范围"
        hint="每行一个相对路径或目录/**。同一文件的并行修改会在合并时检查冲突。"
      >
        <Textarea
          rows={3}
          value={writeText}
          onChange={(e) => {
            setWriteText(e.target.value);
            set(
              "writes",
              e.target.value
                .split("\n")
                .filter((p) => p.trim())
                .map((p) => p.trim()),
            );
          }}
          placeholder={"src/payments/**\nREADME.md"}
        />
      </Field>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">可验证的验收条件</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => set("checks", [...task.checks, newCheck()])}
        >
          <Plus />
          增加条件
        </Button>
      </div>
      {task.checks.map((check, index) => (
        <div key={check.id} className="rounded-lg border p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              验收 {index + 1}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`删除验收 ${index + 1}`}
              disabled={task.checks.length <= 1}
              onClick={() =>
                set(
                  "checks",
                  task.checks.filter((c) => c.id !== check.id),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
          <CheckEditor value={check} onChange={checkUpdate} />
        </div>
      ))}
      <p className="break-all text-xs text-muted-foreground">
        任务标识：{task.id}
      </p>
    </div>
  );
}
function CheckEditor({
  value,
  onChange,
}: {
  value: CheckSpec;
  onChange: (check: CheckSpec) => void;
}) {
  const contentPattern = [
    "text_contains",
    "text_excludes",
    "regex",
    "json_pointer",
  ].includes(value.kind);
  const kind = (next: CheckKind) =>
    onChange({
      id: value.id,
      title: value.title,
      kind: next,
      required: value.required,
      ...(next === "command"
        ? { command: [""], timeoutSeconds: 60, expectedExitCode: 0 }
        : {
            path: value.path ?? "",
            ...([
              "text_contains",
              "text_excludes",
              "regex",
              "json_pointer",
            ].includes(next)
              ? { pattern: "" }
              : {}),
          }),
    });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="条件名称">
          <Input
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
          />
        </Field>
        <Field label="验收类型">
          <NativeSelect
            value={value.kind}
            onChange={(e) => kind(e.target.value as CheckKind)}
          >
            {Object.entries(CHECK_LABELS).map(([k, label]) => (
              <option value={k} key={k}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {value.kind === "command" ? (
        <>
          <Field
            label="命令参数"
            hint="每行一个参数，第一行为程序名。命令在冻结产物的隔离副本中执行，网络禁用。"
          >
            <Textarea
              className="font-mono"
              rows={4}
              value={(value.command ?? []).join("\n")}
              onChange={(e) =>
                onChange({ ...value, command: e.target.value.split("\n") })
              }
              placeholder={"go\ntest\n./..."}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="超时（秒）">
              <Input
                type="number"
                min={1}
                max={3600}
                value={value.timeoutSeconds ?? 60}
                onChange={(e) =>
                  onChange({
                    ...value,
                    timeoutSeconds: Math.max(
                      1,
                      Math.min(3600, Math.floor(e.target.valueAsNumber) || 60),
                    ),
                  })
                }
              />
            </Field>
            <Field label="预期退出码">
              <Input
                type="number"
                min={0}
                max={255}
                value={value.expectedExitCode ?? 0}
                onChange={(e) =>
                  onChange({
                    ...value,
                    expectedExitCode: Math.max(
                      0,
                      Math.min(255, Math.floor(e.target.valueAsNumber) || 0),
                    ),
                  })
                }
              />
            </Field>
          </div>
        </>
      ) : (
        <Field label="验收文件或路径">
          <Input
            value={value.path ?? ""}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
            placeholder="src/payments/refund.go"
          />
        </Field>
      )}
      {contentPattern && (
        <Field
          label={value.kind === "json_pointer" ? "JSON 字段条件" : "匹配条件"}
          hint={
            value.kind === "json_pointer"
              ? '例如 /status="ready"，或 {"pointer":"/total","equals":3}；字段值按 JSON 类型比较。'
              : value.kind === "regex"
                ? "使用 RE2 正则表达式。"
                : undefined
          }
        >
          <Textarea
            className="font-mono"
            value={value.pattern ?? ""}
            onChange={(e) => onChange({ ...value, pattern: e.target.value })}
          />
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.required}
          onChange={(e) => onChange({ ...value, required: e.target.checked })}
        />
        此条件必须通过
      </label>
    </div>
  );
}
