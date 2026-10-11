"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchSpaces, type SpaceItem } from "@/lib/spaces";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import { friendlyError } from "@/lib/project-execution";
import {
  getPortfolio,
  portfolioAction,
  savePortfolioPolicy,
  setProjectScheduling,
  type Portfolio,
  type PortfolioActionItem,
  type PortfolioActionResult,
  type PortfolioPolicy,
  type PortfolioProject,
} from "@/lib/project-workbench";
import {
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "@/components/project-execution/shared";

function SchedulingEditor({
  item,
  busy,
  onSave,
}: {
  item: PortfolioProject;
  busy: boolean;
  onSave: (priority: number, weight: number) => void;
}) {
  const [priority, setPriority] = useState(item.scheduling.priority);
  const [weight, setWeight] = useState(item.scheduling.weight || 1);
  useEffect(() => {
    setPriority(item.scheduling.priority);
    setWeight(item.scheduling.weight || 1);
  }, [item.project.revision, item.scheduling.priority, item.scheduling.weight]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={`项目 ${item.project.name} 优先级`}>
        <Input
          className="w-24"
          type="number"
          min={-20}
          max={20}
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
      </Field>
      <Field label={`项目 ${item.project.name} 公平权重`}>
        <Input
          className="w-24"
          type="number"
          min={1}
          max={100}
          value={weight}
          onChange={(e) => setWeight(Number(e.target.value))}
        />
      </Field>
      <Button
        size="sm"
        variant="outline"
        disabled={
          busy ||
          !Number.isInteger(priority) ||
          !Number.isInteger(weight) ||
          priority < -20 ||
          priority > 20 ||
          weight < 1 ||
          weight > 100 ||
          (priority === item.scheduling.priority &&
            weight === (item.scheduling.weight || 1))
        }
        onClick={() => onSave(priority, weight)}
      >
        保存调度权重
      </Button>
    </div>
  );
}

export default function ProjectPortfolio() {
  const me = useMeOptional();
  const operator = Boolean(
    me?.user?.id && ["owner", "admin"].includes(me.role ?? ""),
  );
  const writable = Boolean(
    me && ["owner", "admin", "member"].includes(me.role ?? ""),
  );
  const [data, setData] = useState<Portfolio | null>(null);
  const [policy, setPolicy] = useState<PortfolioPolicy | null>(null);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [selected, setSelected] = useState<PortfolioActionItem[]>([]);
  const [action, setAction] = useState<"pause" | "resume" | "cancel">("pause");
  const [confirmed, setConfirmed] = useState(false);
  const [policyConfirmed, setPolicyConfirmed] = useState(false);
  const [results, setResults] = useState<PortfolioActionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const next = await getPortfolio(spaceId);
    setData(next);
    setPolicy(next.policy);
    setSelected([]);
    setConfirmed(false);
    setPolicyConfirmed(false);
  }, [spaceId]);
  useEffect(() => {
    let active = true;
    void Promise.all([getPortfolio(spaceId), fetchSpaces(), fetchAgents()])
      .then(([data, spaces, agents]) => {
        if (active) {
          setData(data);
          setPolicy(data.policy);
          setSpaces(spaces);
          setAgents(agents);
          setSelected([]);
          setConfirmed(false);
          setPolicyConfirmed(false);
        }
      })
      .catch((e) => active && setError(friendlyError(e)));
    return () => {
      active = false;
    };
  }, [spaceId]);
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
  const updatePolicy = (next: PortfolioPolicy) => {
    setPolicy(next);
    setPolicyConfirmed(false);
  };
  const selectRun = (item: PortfolioActionItem, checked: boolean) => {
    setSelected((previous) =>
      checked
        ? [...previous.filter((p) => p.runId !== item.runId), item]
        : previous.filter((p) => p.runId !== item.runId),
    );
    setConfirmed(false);
  };
  const totalsLabels: Record<keyof Portfolio["totals"], string> = {
    projects: "项目",
    runs: "轮次",
    pendingTasks: "待执行任务",
    activeTasks: "正在执行",
    waitingReviewTasks: "等待验收",
    unknownOperations: "结果待确认操作",
    tokens: "已用 Token",
    modelCalls: "模型调用",
    toolCalls: "工具调用",
  };
  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">项目组合与公平调度</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            查看跨项目队列、真实资源使用与受阻原因，按权重分配共享 Agent
            和并发容量。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/project-executions">
            <Button variant="outline">项目列表</Button>
          </Link>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(reload)}
          >
            <RefreshCw />
            刷新
          </Button>
        </div>
      </header>
      <ErrorNotice message={error} />
      <Field label="组合空间范围">
        <NativeSelect
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
        >
          <option value="">整个团队</option>
          {spaces.map((space) => (
            <option value={space.id} key={space.id}>
              {space.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {!data ? (
        <p className="text-sm text-muted-foreground">正在读取组合队列…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {(Object.keys(totalsLabels) as (keyof Portfolio["totals"])[]).map(
              (key) => (
                <div className="rounded-xl border bg-card p-4" key={key}>
                  <p className="text-xs text-muted-foreground">
                    {totalsLabels[key]}
                  </p>
                  <p className="mt-2 text-xl font-semibold">
                    {data.totals[key].toLocaleString()}
                  </p>
                </div>
              ),
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            读取于 {new Date(data.generatedAt).toLocaleString("zh-CN")} ·
            并发计量范围{" "}
            {data.concurrencyScope === "tenant"
              ? "整个团队（即使当前只筛选一个空间）"
              : data.concurrencyScope}
            {data.truncated ? " · 项目列表达到上限，总览结果不完整" : ""}
          </p>
          <Panel
            title="批量轮次控制"
            description="每项操作独立提交；发生修订冲突时保留其他项结果，不会整体回滚。重新刷新会清空选择以避免使用旧修订。"
          >
            <div className="flex flex-wrap items-end gap-3">
              <Field label="批量操作">
                <NativeSelect
                  value={action}
                  onChange={(e) => {
                    setAction(e.target.value as typeof action);
                    setConfirmed(false);
                  }}
                >
                  <option value="pause">暂停所选轮次</option>
                  <option value="resume">恢复所选轮次</option>
                  <option value="cancel">取消所选轮次</option>
                </NativeSelect>
              </Field>
              <span className="text-sm">已选择 {selected.length} 轮</span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                确认对所选修订执行此操作
              </label>
              <Button
                variant={action === "cancel" ? "destructive" : "default"}
                disabled={busy || !writable || !confirmed || !selected.length}
                onClick={() =>
                  void act(async () => {
                    const result = await portfolioAction(action, selected);
                    setResults(result.items ?? []);
                    await reload();
                  })
                }
              >
                执行批量控制
              </Button>
            </div>
            {results.length > 0 && (
              <div className="mt-4 space-y-2" aria-live="polite">
                {results.map((item) => (
                  <div key={item.runId} className="rounded border p-2 text-sm">
                    <span
                      className={
                        item.status === "applied"
                          ? "text-green-600"
                          : "text-destructive"
                      }
                    >
                      {item.status}
                    </span>{" "}
                    · {item.runId} {item.error && <span>· {item.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <div className="space-y-4">
            {data.projects.map((item) => (
              <Panel
                key={item.project.id}
                title={item.project.name}
                description={`公平累计服务 ${item.fairService.toFixed(3)} · 项目修订 ${item.project.revision}`}
                actions={
                  <Link
                    href={`/dashboard/project-executions/${encodeURIComponent(item.project.id)}`}
                  >
                    <Button size="sm" variant="outline">
                      打开项目
                    </Button>
                  </Link>
                }
              >
                <p className="mb-4 text-sm text-muted-foreground">
                  {item.project.goal}
                </p>
                {writable && (
                  <SchedulingEditor
                    item={item}
                    busy={busy}
                    onSave={(priority, weight) =>
                      void act(async () => {
                        await setProjectScheduling(item, priority, weight);
                        await reload();
                      })
                    }
                  />
                )}
                <div className="mt-4 space-y-3">
                  {item.runs.map(({ run, counts, blocking }) => (
                    <div className="rounded-lg border p-3" key={run.id}>
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            disabled={
                              !writable ||
                              busy ||
                              ["completed", "cancelled"].includes(run.status)
                            }
                            checked={selected.some((s) => s.runId === run.id)}
                            onChange={(e) =>
                              selectRun(
                                {
                                  projectId: item.project.id,
                                  runId: run.id,
                                  expectedRevision: run.revision,
                                },
                                e.target.checked,
                              )
                            }
                          />
                          v{run.planVersion} · {run.id.slice(0, 12)}
                        </label>
                        <Status value={run.status} />
                        <span className="text-xs text-muted-foreground">
                          r{run.revision} · {run.tokens.toLocaleString()} Token
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-3 text-xs">
                        <span>排队 {counts.pending}</span>
                        <span>执行 {counts.active}</span>
                        <span>人工验收 {counts.waitingReview}</span>
                        <span>副作用审批 {counts.waitingApproval}</span>
                        <span>未知 {counts.unknown}</span>
                        <span>完成 {counts.completed}</span>
                        <span>失败 {counts.failed}</span>
                        <span>取消 {counts.cancelled}</span>
                      </div>
                      {blocking.length > 0 && (
                        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                          {blocking.map((blocker, i) => (
                            <li key={i}>
                              <strong>{blocker.code}</strong> · {blocker.detail}
                              {blocker.nextEligibleAt &&
                                ` · 最早重试 ${new Date(blocker.nextEligibleAt).toLocaleString("zh-CN")}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                  {!item.runs.length && (
                    <p className="text-sm text-muted-foreground">
                      尚未启动执行轮次。
                    </p>
                  )}
                </div>
              </Panel>
            ))}
            {!data.projects.length && (
              <Panel title="没有项目">
                <p className="text-sm text-muted-foreground">
                  当前范围没有长期项目。
                </p>
              </Panel>
            )}
          </div>
          {policy && (
            <Panel
              title="团队 QoS 策略"
              description="并发与 Agent 调用容量为整个团队共享。0 表示组合层不设上限，执行器和项目自己的预算仍然生效。"
              actions={
                !operator ? (
                  <span className="text-xs text-muted-foreground">
                    仅团队管理员可修改
                  </span>
                ) : undefined
              }
            >
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!operator}
                    checked={policy.enabled}
                    onChange={(e) =>
                      updatePolicy({ ...policy, enabled: e.target.checked })
                    }
                  />
                  启用组合公平调度与容量限制
                </label>
                <div className="grid gap-3 md:grid-cols-4">
                  {(
                    [
                      ["maxActiveTasks", "团队最大活跃任务"],
                      ["defaultAgentModelCalls", "默认 Agent 模型调用容量"],
                      ["defaultAgentToolCalls", "默认 Agent 工具调用容量"],
                      ["agingSeconds", "等待老化秒数"],
                    ] as const
                  ).map(([key, label]) => (
                    <Field label={label} key={key}>
                      <Input
                        type="number"
                        min={key === "agingSeconds" ? 1 : 0}
                        disabled={!operator}
                        value={policy[key]}
                        onChange={(e) =>
                          updatePolicy({
                            ...policy,
                            [key]: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
                <div className="space-y-3">
                  {policy.agents.map((limit, i) => (
                    <div
                      className="grid items-end gap-3 rounded border p-3 md:grid-cols-[1fr_1fr_1fr_auto]"
                      key={i}
                    >
                      <Field label={`Agent 特定容量 ${i + 1}`}>
                        <NativeSelect
                          disabled={!operator}
                          value={limit.agentId}
                          onChange={(e) =>
                            updatePolicy({
                              ...policy,
                              agents: policy.agents.map((a, n) =>
                                n === i ? { ...a, agentId: e.target.value } : a,
                              ),
                            })
                          }
                        >
                          <option value="">选择 Agent</option>
                          {agents.map((agent) => (
                            <option value={agent.id} key={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                      <Field label="同时模型调用">
                        <Input
                          disabled={!operator}
                          type="number"
                          min={0}
                          value={limit.maxModelCalls}
                          onChange={(e) =>
                            updatePolicy({
                              ...policy,
                              agents: policy.agents.map((a, n) =>
                                n === i
                                  ? {
                                      ...a,
                                      maxModelCalls: Number(e.target.value),
                                    }
                                  : a,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="同时工具调用">
                        <Input
                          disabled={!operator}
                          type="number"
                          min={0}
                          value={limit.maxToolCalls}
                          onChange={(e) =>
                            updatePolicy({
                              ...policy,
                              agents: policy.agents.map((a, n) =>
                                n === i
                                  ? {
                                      ...a,
                                      maxToolCalls: Number(e.target.value),
                                    }
                                  : a,
                              ),
                            })
                          }
                        />
                      </Field>
                      {operator && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            updatePolicy({
                              ...policy,
                              agents: policy.agents.filter((_, n) => n !== i),
                            })
                          }
                        >
                          移除
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                {operator && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        updatePolicy({
                          ...policy,
                          agents: [
                            ...policy.agents,
                            { agentId: "", maxModelCalls: 0, maxToolCalls: 0 },
                          ],
                        })
                      }
                    >
                      添加 Agent 容量
                    </Button>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={policyConfirmed}
                        onChange={(e) => setPolicyConfirmed(e.target.checked)}
                      />
                      确认修改团队策略修订 {policy.revision}
                    </label>
                    <Button
                      disabled={busy || !policyConfirmed}
                      onClick={() =>
                        void act(async () => {
                          await savePortfolioPolicy(policy);
                          await reload();
                        })
                      }
                    >
                      保存团队调度策略
                    </Button>
                  </>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
