"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  defaultDefinition,
  newCheck,
  type Budget,
} from "@/lib/project-execution";
import type {
  BlueprintDefinition,
  BlueprintParameter,
  BlueprintTask,
  Scalar,
} from "@/lib/project-workbench";
import { ErrorNotice, Field, NativeSelect, Panel } from "./shared";

export function emptyBlueprint(): BlueprintDefinition {
  return {
    name: "",
    description: "",
    projectName: "",
    goal: "",
    parameters: [],
    tasks: [
      {
        key: "deliver",
        title: "交付任务",
        prompt: "",
        agentRole: "builder",
        dependsOn: [],
        writes: [],
        priority: 0,
        maxAttempts: 3,
        checks: [newCheck()],
      },
    ],
    config: defaultDefinition().config,
  };
}

function JSONField({
  label,
  value,
  onChange,
  onValid,
  hint,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onValid: (valid: boolean) => void;
  hint?: string;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    setText(JSON.stringify(JSON.parse(serialized ?? "null"), null, 2));
    setError(null);
  }, [serialized]);
  return (
    <div>
      <Field label={label} hint={hint}>
        <Textarea
          rows={4}
          className="font-mono text-xs"
          value={text}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            try {
              const parsed = JSON.parse(next);
              onChange(parsed);
              setError(null);
              onValid(true);
            } catch {
              setError("JSON 格式尚未有效；保存与预览已禁用。");
              onValid(false);
            }
          }}
        />
      </Field>
      <ErrorNotice message={error} />
    </div>
  );
}

export function BlueprintEditor({
  value,
  onChange,
  onValidity,
}: {
  value: BlueprintDefinition;
  onChange: (value: BlueprintDefinition) => void;
  onValidity: (valid: boolean) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const valid = (key: string, ok: boolean) =>
    setInvalid((previous) => {
      const next = new Set(previous);
      if (ok) next.delete(key);
      else next.add(key);
      return next;
    });
  useEffect(() => onValidity(invalid.size === 0), [invalid, onValidity]);
  const task = value.tasks[selected] ?? value.tasks[0];
  const updateParameter = (index: number, parameter: BlueprintParameter) =>
    onChange({
      ...value,
      parameters: value.parameters.map((p, i) => (i === index ? parameter : p)),
    });
  const updateTask = (next: BlueprintTask) =>
    onChange({
      ...value,
      tasks: value.tasks.map((t, i) => (i === selected ? next : t)),
    });
  const budgetLabels: Record<keyof Budget, string> = {
    maxTokens: "Token 总预算",
    maxModelCalls: "模型调用上限",
    maxToolCalls: "工具调用上限",
    maxWallSeconds: "最长执行秒数",
    maxConcurrent: "项目并发任务",
  };
  return (
    <div className="space-y-4">
      <Panel
        title="蓝图目标"
        description="参数占位符 {{param.NAME}} 与矩阵占位符 {{matrix.AXIS}} 只替换一次，不执行代码。"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="蓝图名称">
            <Input
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
            />
          </Field>
          <Field label="实例项目名称">
            <Input
              value={value.projectName}
              onChange={(e) =>
                onChange({ ...value, projectName: e.target.value })
              }
            />
          </Field>
        </div>
        <div className="mt-3 space-y-3">
          <Field label="蓝图说明">
            <Textarea
              value={value.description}
              onChange={(e) =>
                onChange({ ...value, description: e.target.value })
              }
            />
          </Field>
          <Field label="参数化交付目标">
            <Textarea
              value={value.goal}
              onChange={(e) => onChange({ ...value, goal: e.target.value })}
            />
          </Field>
        </div>
      </Panel>
      <Panel
        title="参数约束"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...value,
                parameters: [
                  ...value.parameters,
                  {
                    name: `parameter_${value.parameters.length + 1}`,
                    title: "",
                    type: "string",
                    required: true,
                  },
                ],
              })
            }
          >
            <Plus />
            添加参数
          </Button>
        }
      >
        {!value.parameters.length && (
          <p className="text-sm text-muted-foreground">
            无参数。添加路径、枚举、整数或布尔值，以复用目标与任务。
          </p>
        )}
        <div className="space-y-4">
          {value.parameters.map((parameter, index) => (
            <div className="space-y-3 rounded-lg border p-3" key={index}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={`参数 ${index + 1} 标识符`}>
                  <Input
                    value={parameter.name}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        name: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="显示标题">
                  <Input
                    value={parameter.title}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        title: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="参数类型">
                  <NativeSelect
                    value={parameter.type}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        type: e.target.value as BlueprintParameter["type"],
                        default: undefined,
                      })
                    }
                  >
                    {["string", "path", "int", "bool", "enum"].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field label="参数说明">
                <Input
                  value={parameter.description ?? ""}
                  onChange={(e) =>
                    updateParameter(index, {
                      ...parameter,
                      description: e.target.value,
                    })
                  }
                />
              </Field>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={parameter.required}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        required: e.target.checked,
                      })
                    }
                  />
                  必需参数
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={parameter.default !== undefined}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        default: e.target.checked
                          ? parameter.type === "bool"
                            ? false
                            : parameter.type === "int"
                              ? 0
                              : ""
                          : undefined,
                      })
                    }
                  />
                  提供默认值
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`删除参数 ${parameter.name}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      parameters: value.parameters.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              {parameter.default !== undefined && (
                <Field label="默认值">
                  {parameter.type === "bool" ? (
                    <NativeSelect
                      value={String(parameter.default)}
                      onChange={(e) =>
                        updateParameter(index, {
                          ...parameter,
                          default: e.target.value === "true",
                        })
                      }
                    >
                      <option value="false">false</option>
                      <option value="true">true</option>
                    </NativeSelect>
                  ) : (
                    <Input
                      type={parameter.type === "int" ? "number" : "text"}
                      value={String(parameter.default)}
                      onChange={(e) =>
                        updateParameter(index, {
                          ...parameter,
                          default:
                            parameter.type === "int"
                              ? Number(e.target.value)
                              : e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
              )}
              {parameter.type === "enum" && (
                <Field label="枚举值（每行一个）">
                  <Textarea
                    value={(parameter.enum ?? []).join("\n")}
                    onChange={(e) =>
                      updateParameter(index, {
                        ...parameter,
                        enum: e.target.value.split("\n").filter(Boolean),
                      })
                    }
                  />
                </Field>
              )}
              {parameter.type === "int" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["minimum", "maximum"] as const).map((key) => (
                    <Field
                      label={key === "minimum" ? "最小整数" : "最大整数"}
                      key={key}
                    >
                      <Input
                        type="number"
                        value={parameter[key] ?? ""}
                        onChange={(e) =>
                          updateParameter(index, {
                            ...parameter,
                            [key]:
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              ) : (
                parameter.type !== "bool" && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="最小字符数">
                      <Input
                        type="number"
                        min={0}
                        value={parameter.minLength ?? 0}
                        onChange={(e) =>
                          updateParameter(index, {
                            ...parameter,
                            minLength: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="最大字符数（0 使用默认）">
                      <Input
                        type="number"
                        min={0}
                        value={parameter.maxLength ?? 0}
                        onChange={(e) =>
                          updateParameter(index, {
                            ...parameter,
                            maxLength: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="正则约束">
                      <Input
                        value={parameter.pattern ?? ""}
                        onChange={(e) =>
                          updateParameter(index, {
                            ...parameter,
                            pattern: e.target.value,
                          })
                        }
                      />
                    </Field>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title="任务与矩阵"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(value.tasks.length);
              onChange({
                ...value,
                tasks: [
                  ...value.tasks,
                  {
                    key: `task_${value.tasks.length + 1}`,
                    title: "",
                    prompt: "",
                    agentRole: "builder",
                    dependsOn: [],
                    writes: [],
                    priority: 0,
                    maxAttempts: 3,
                    checks: [newCheck()],
                  },
                ],
              });
            }}
          >
            <Plus />
            添加任务
          </Button>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          {value.tasks.map((item, i) => (
            <Button
              size="sm"
              variant={selected === i ? "default" : "outline"}
              key={i}
              onClick={() => {
                setSelected(i);
                setInvalid(new Set());
              }}
            >
              {item.title || item.key}
            </Button>
          ))}
        </div>
        {task && (
          <div className="space-y-3" key={selected}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="任务键">
                <Input
                  value={task.key}
                  onChange={(e) => updateTask({ ...task, key: e.target.value })}
                />
              </Field>
              <Field label="任务标题">
                <Input
                  value={task.title}
                  onChange={(e) =>
                    updateTask({ ...task, title: e.target.value })
                  }
                />
              </Field>
              <Field label="Agent 角色">
                <Input
                  value={task.agentRole}
                  onChange={(e) =>
                    updateTask({ ...task, agentRole: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="执行要求">
              <Textarea
                rows={5}
                value={task.prompt}
                onChange={(e) =>
                  updateTask({ ...task, prompt: e.target.value })
                }
              />
            </Field>
            <Field label="写入路径（每行一个，可含参数或矩阵占位符）">
              <Textarea
                value={task.writes.join("\n")}
                onChange={(e) =>
                  updateTask({
                    ...task,
                    writes: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="模型（留空使用 Agent 默认）">
                <Input
                  value={task.model ?? ""}
                  onChange={(e) =>
                    updateTask({ ...task, model: e.target.value })
                  }
                />
              </Field>
              <Field label="任务优先级">
                <Input
                  type="number"
                  value={task.priority}
                  onChange={(e) =>
                    updateTask({ ...task, priority: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="最大尝试次数">
                <Input
                  type="number"
                  min={1}
                  value={task.maxAttempts}
                  onChange={(e) =>
                    updateTask({ ...task, maxAttempts: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <JSONField
                label="矩阵轴 JSON"
                hint={'例如 {"locale":["zh","en"]}；为空使用 {}。'}
                value={task.matrix ?? {}}
                onValid={(ok) => valid("matrix", ok)}
                onChange={(matrix) =>
                  updateTask({
                    ...task,
                    matrix: matrix as BlueprintTask["matrix"],
                  })
                }
              />
              <JSONField
                label="依赖选择器 JSON"
                hint={
                  '例如 [{"task":"build","matchAxes":["locale"]}]；空 matchAxes 依赖所有上游实例。'
                }
                value={task.dependsOn}
                onValid={(ok) => valid("dependencies", ok)}
                onChange={(dependsOn) =>
                  updateTask({
                    ...task,
                    dependsOn: dependsOn as BlueprintTask["dependsOn"],
                  })
                }
              />
            </div>
            <JSONField
              label="验收条件 JSON"
              hint="支持路径、文本、JSON 字段、正则及隔离命令。每个实例至少需要一个 required 验收。"
              value={task.checks}
              onValid={(ok) => valid("checks", ok)}
              onChange={(checks) =>
                updateTask({
                  ...task,
                  checks: checks as BlueprintTask["checks"],
                })
              }
            />
            <JSONField
              label="条件 JSON（无条件填 null）"
              hint={
                '例如 {"ref":"param.enable_docs","op":"eq","value":true}；支持 all、any、not。'
              }
              value={task.when ?? null}
              onValid={(ok) => valid("when", ok)}
              onChange={(when) =>
                updateTask({
                  ...task,
                  when:
                    when === null ? undefined : (when as BlueprintTask["when"]),
                })
              }
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={value.tasks.length < 2}
              onClick={() => {
                onChange({
                  ...value,
                  tasks: value.tasks.filter((_, i) => i !== selected),
                });
                setSelected(0);
                setInvalid(new Set());
              }}
            >
              删除此任务
            </Button>
          </div>
        )}
      </Panel>
      <Panel title="实例运行预算与审核">
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(budgetLabels) as (keyof Budget)[]).map((key) => (
            <Field label={budgetLabels[key]} key={key}>
              <Input
                type="number"
                min={key === "maxConcurrent" ? 1 : 0}
                value={value.config.budget[key]}
                onChange={(e) =>
                  onChange({
                    ...value,
                    config: {
                      ...value.config,
                      budget: {
                        ...value.config.budget,
                        [key]: Number(e.target.value),
                      },
                    },
                  })
                }
              />
            </Field>
          ))}
          <Field label="最大展开任务">
            <Input
              type="number"
              min={1}
              max={1000}
              value={value.config.maxTasks}
              onChange={(e) =>
                onChange({
                  ...value,
                  config: { ...value.config, maxTasks: Number(e.target.value) },
                })
              }
            />
          </Field>
          <Field label="外部副作用">
            <NativeSelect
              value={value.config.externalEffects}
              onChange={(e) =>
                onChange({
                  ...value,
                  config: {
                    ...value.config,
                    externalEffects: e.target.value as
                      "deny" | "review" | "allow",
                  },
                })
              }
            >
              <option value="deny">禁止</option>
              <option value="review">人工批准</option>
              <option value="allow">允许</option>
            </NativeSelect>
          </Field>
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
            任务完成需要人工验收
          </label>
        </div>
      </Panel>
    </div>
  );
}

export function ParameterValues({
  definition,
  values,
  onChange,
}: {
  definition: BlueprintDefinition;
  values: Record<string, Scalar>;
  onChange: (values: Record<string, Scalar>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {definition.parameters.map((parameter) => (
        <Field
          label={`${parameter.title || parameter.name}${parameter.required ? " *" : ""}`}
          key={parameter.name}
          hint={parameter.description}
        >
          {parameter.type === "bool" ? (
            <NativeSelect
              value={
                values[parameter.name] === undefined
                  ? ""
                  : String(values[parameter.name])
              }
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[parameter.name];
                else next[parameter.name] = e.target.value === "true";
                onChange(next);
              }}
            >
              <option value="">使用默认值 / 不提供</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </NativeSelect>
          ) : parameter.type === "enum" ? (
            <NativeSelect
              value={String(values[parameter.name] ?? "")}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value) next[parameter.name] = e.target.value;
                else delete next[parameter.name];
                onChange(next);
              }}
            >
              <option value="">使用默认值 / 不提供</option>
              {(parameter.enum ?? []).map((item) => (
                <option key={item}>{item}</option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              type={parameter.type === "int" ? "number" : "text"}
              value={String(values[parameter.name] ?? "")}
              placeholder={
                parameter.default === undefined
                  ? "未提供"
                  : `默认：${parameter.default}`
              }
              min={parameter.minimum}
              max={parameter.maximum}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[parameter.name];
                else
                  next[parameter.name] =
                    parameter.type === "int"
                      ? Number(e.target.value)
                      : e.target.value;
                onChange(next);
              }}
            />
          )}
        </Field>
      ))}
    </div>
  );
}
