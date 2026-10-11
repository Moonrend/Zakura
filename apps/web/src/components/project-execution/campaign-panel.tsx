"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMeOptional } from "@/components/me-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchAgents, type AgentListItem } from "@/lib/agents";
import {
  friendlyError,
  type Budget,
  type Project,
} from "@/lib/project-execution";
import {
  getTemplate,
  listTemplates,
  templateVersions,
  type BlueprintParameter,
  type ProjectTemplate,
  type Scalar,
  type TemplateVersion,
} from "@/lib/project-workbench";
import {
  campaignAction,
  campaignVariantAction,
  controlCampaign,
  createCampaign,
  getCampaign,
  getCampaignAudit,
  listCampaigns,
  type Campaign,
  type CampaignAudit,
  type CampaignComparison,
  type CampaignResult,
  type CampaignVariantSpec,
} from "@/lib/project-campaign";
import {
  Code,
  ErrorNotice,
  Field,
  NativeSelect,
  Panel,
  Status,
} from "./shared";

const initialBudget = (): Budget => ({
  maxTokens: 100000,
  maxModelCalls: 40,
  maxToolCalls: 80,
  maxWallSeconds: 3600,
  maxConcurrent: 1,
});
const variant = (id: string, name: string): CampaignVariantSpec => ({
  id,
  name,
  agentMapping: {},
  models: {},
});
const budgetFields: { key: keyof Budget; label: string; max: number }[] = [
  { key: "maxTokens", label: "总 Token 上限", max: 1e12 },
  { key: "maxModelCalls", label: "总模型调用上限", max: 1e6 },
  { key: "maxToolCalls", label: "总工具调用上限", max: 1e6 },
  { key: "maxWallSeconds", label: "总运行秒数上限", max: 2592000 },
  { key: "maxConcurrent", label: "同时运行的变体数", max: 16 },
];
function parameterValue(
  p: BlueprintParameter,
  text: string,
): Scalar | undefined {
  if (text === "" && !p.required) return undefined;
  if (p.type === "bool") return text === "true";
  if (p.type === "int") {
    const number = Number(text);
    if (text.trim() === "" || !Number.isSafeInteger(number))
      throw new Error(`${p.title || p.name} 需要安全范围内的整数`);
    return number;
  }
  return text;
}
function ParameterInput({
  parameter: p,
  value,
  change,
}: {
  parameter: BlueprintParameter;
  value: string;
  change: (value: string) => void;
}) {
  const options = p.type === "bool" ? ["false", "true"] : (p.enum ?? []);
  return (
    <Field
      label={`${p.title || p.name}${p.required ? " *" : ""}`}
      hint={p.description}
    >
      {p.type === "bool" || p.type === "enum" ? (
        <NativeSelect value={value} onChange={(e) => change(e.target.value)}>
          <option value="">
            {p.required ? "请选择" : "使用默认值 / 不传入"}
          </option>
          {options.map((item) => (
            <option key={item} value={item}>
              {item === "true" ? "是" : item === "false" ? "否" : item}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          value={value}
          type={p.type === "int" ? "number" : "text"}
          min={p.minimum}
          max={p.maximum}
          minLength={p.minLength}
          maxLength={p.maxLength}
          placeholder={p.type === "path" ? "相对项目路径" : undefined}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </Field>
  );
}

export function CampaignPanel({ project }: { project: Project }) {
  const me = useMeOptional();
  const writable = Boolean(
    me && ["owner", "admin", "member"].includes(me.role ?? ""),
  );
  const human = writable && Boolean(me?.user?.id);
  const generation = useRef(0);
  const refreshSequence = useRef(0);
  const selection = useRef<string | undefined>(undefined);
  const [items, setItems] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [version, setVersion] = useState<number>();
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [budget, setBudget] = useState(initialBudget);
  const [variants, setVariants] = useState<CampaignVariantSpec[]>([
    variant("baseline", "基准"),
    variant("candidate", "候选"),
  ]);
  const [baseline, setBaseline] = useState("baseline");
  const [current, setCurrent] = useState<Campaign>();
  const [comparison, setComparison] = useState<CampaignComparison>();
  const [audit, setAudit] = useState<CampaignAudit[]>([]);
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(
    async (id?: string, epoch = generation.current) => {
      const sequence = ++refreshSequence.current;
      const list = await listCampaigns(project.id);
      if (epoch !== generation.current || sequence !== refreshSequence.current)
        return;
      setItems(list.items ?? []);
      const next = id ?? selection.current;
      if (!next) return;
      const [detail, history] = await Promise.all([
        getCampaign(next),
        getCampaignAudit(next),
      ]);
      if (
        epoch !== generation.current ||
        sequence !== refreshSequence.current ||
        selection.current !== next
      )
        return;
      setCurrent(detail.campaign);
      setComparison(detail.comparison);
      setAudit(history.items ?? []);
    },
    [project.id],
  );

  useEffect(() => {
    const epoch = ++generation.current;
    selection.current = undefined;
    setCurrent(undefined);
    setComparison(undefined);
    setAudit([]);
    setItems([]);
    setTemplateId("");
    setTemplate(undefined);
    setVersions([]);
    setVersion(undefined);
    setParameters({});
    setError(null);
    setNotice(null);
    setComment("");
    setConfirmed(false);
    setBusy(false);
    setName(`${project.name} 配置比较`);
    setShowCreate(false);
    Promise.all([listCampaigns(project.id), listTemplates(), fetchAgents()])
      .then(([campaigns, library, available]) => {
        if (epoch !== generation.current) return;
        setItems(campaigns.items ?? []);
        setTemplates(library.items ?? []);
        setAgents(
          available.filter((agent) => agent.spaceId === project.spaceId),
        );
      })
      .catch((err) => {
        if (epoch === generation.current) setError(friendlyError(err));
      });
    return () => {
      generation.current++;
    };
  }, [project.id, project.spaceId, project.name]);

  useEffect(() => {
    if (!templateId) {
      setTemplate(undefined);
      setVersions([]);
      setVersion(undefined);
      return;
    }
    let active = true;
    const epoch = generation.current;
    Promise.all([getTemplate(templateId), templateVersions(templateId)])
      .then(([selected, history]) => {
        if (!active || epoch !== generation.current) return;
        setTemplate(selected);
        setVersions(history.items ?? []);
        setVersion(selected.currentVersion);
      })
      .catch((err) => {
        if (active && epoch === generation.current)
          setError(friendlyError(err));
      });
    return () => {
      active = false;
    };
  }, [templateId]);

  const definition = versions.find(
    (item) => item.version === version,
  )?.definition;
  const roles = [
    ...new Set(definition?.tasks.map((task) => task.agentRole) ?? []),
  ].sort();
  useEffect(() => {
    const fields: Record<string, string> = {};
    for (const p of definition?.parameters ?? [])
      fields[p.name] = p.default === undefined ? "" : String(p.default);
    setParameters(fields);
  }, [definition]);

  useEffect(() => {
    if (!current?.id || busy) return;
    const id = current.id,
      epoch = generation.current;
    const timer = window.setInterval(() => {
      refresh(id, epoch).catch((err) => {
        if (epoch === generation.current) setError(friendlyError(err));
      });
    }, 7000);
    return () => window.clearInterval(timer);
  }, [current?.id, busy, refresh]);

  const choose = async (id: string) => {
    const epoch = generation.current;
    refreshSequence.current++;
    selection.current = id || undefined;
    setCurrent(undefined);
    setComparison(undefined);
    setAudit([]);
    setError(null);
    setNotice(null);
    setComment("");
    setConfirmed(false);
    if (id)
      try {
        await refresh(id);
      } catch (err) {
        if (epoch === generation.current && selection.current === id)
          setError(friendlyError(err));
      }
  };
  const operate = async (
    action: () => Promise<CampaignResult>,
    success: string,
  ) => {
    const epoch = generation.current;
    refreshSequence.current++;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (epoch !== generation.current) return;
      selection.current = result.campaign.id;
      setCurrent(result.campaign);
      const failures = [
        result.error,
        ...(result.results ?? []).map((row) => row.error),
      ].filter(Boolean);
      setNotice(
        failures.length
          ? `${success}；部分结果待处理：${failures.join("；")}`
          : success,
      );
      setConfirmed(false);
      await refresh(result.campaign.id, epoch);
    } catch (err) {
      if (epoch === generation.current) {
        setError(friendlyError(err));
        try {
          await refresh(selection.current, epoch);
        } catch {
          /* Keep the concrete action error visible. */
        }
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const make = async () => {
    if (!template || !definition || !version) return;
    try {
      if (!name.trim()) throw new Error("请填写活动名称");
      if (!variants.some((item) => item.id === baseline))
        throw new Error("请选择有效基准");
      const values: Record<string, Scalar> = {};
      for (const p of definition.parameters) {
        const text = parameters[p.name] ?? "";
        if (text === "" && p.default !== undefined) continue;
        if (text === "" && p.required)
          throw new Error(`请填写 ${p.title || p.name}`);
        const value = parameterValue(p, text);
        if (value !== undefined) values[p.name] = value;
      }
      for (const v of variants)
        for (const role of roles) {
          if (!v.agentMapping[role])
            throw new Error(`请为 ${v.name} 的 ${role} 选择 Agent`);
        }
      for (const field of budgetFields) {
        const value = budget[field.key];
        const min = field.key === "maxConcurrent" ? 1 : variants.length;
        if (!Number.isSafeInteger(value) || value < min || value > field.max)
          throw new Error(`${field.label} 需要 ${min} 到 ${field.max} 的整数`);
      }
      await operate(
        () =>
          createCampaign({
            name,
            sourceProjectId: project.id,
            templateId: template.id,
            expectedTemplateRevision: template.revision,
            templateVersion: version,
            baselineId: baseline,
            budget,
            parameters: values,
            variants: variants.map((v) => ({
              ...v,
              agentMapping: Object.fromEntries(
                roles.map((role) => [role, v.agentMapping[role]]),
              ),
              models: Object.fromEntries(
                roles
                  .filter((role) => v.models?.[role]?.trim())
                  .map((role) => [role, v.models![role].trim()]),
              ),
            })),
          }),
        "已创建独立草稿，尚未冻结源文件或启动运行",
      );
      setShowCreate(false);
    } catch (err) {
      setError(friendlyError(err));
    }
  };
  const changeVariant = (index: number, value: CampaignVariantSpec) =>
    setVariants((old) => old.map((item, i) => (i === index ? value : item)));
  const permitted =
    human && comment.trim().length > 0 && comment.length <= 4096 && !busy;
  const ambiguous = Boolean(
    current &&
    (["capturing", "unknown"].includes(current.captureState) ||
      current.status === "controlling" ||
      current.definition.variants.some((v) =>
        ["copying", "copy_unknown", "starting", "start_unknown"].includes(
          v.state,
        ),
      )),
  );

  return (
    <Panel
      title="Agent / 模型实验活动"
      description="冻结同一版本蓝图与源快照，逐项运行独立变体，比较真实验收证据和执行用量。"
      actions={
        <Button
          size="sm"
          variant="secondary"
          disabled={!writable || busy}
          onClick={() => setShowCreate((value) => !value)}
        >
          {showCreate ? "收起创建表单" : "创建实验"}
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorNotice message={error} />
        {notice && (
          <p
            role="status"
            className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap"
          >
            {notice}
          </p>
        )}
        {showCreate && (
          <div className="space-y-4 rounded-lg border p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="活动名称">
                <Input
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="版本蓝图">
                <NativeSelect
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value);
                    setTemplate(undefined);
                    setVersions([]);
                  }}
                >
                  <option value="">选择已保存蓝图</option>
                  {templates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.definition.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="冻结版本">
                <NativeSelect
                  value={version ?? ""}
                  onChange={(e) => setVersion(Number(e.target.value))}
                  disabled={!template}
                >
                  <option value="">选择版本</option>
                  {versions.map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {templates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                先在蓝图库保存一个蓝图，再为相同任务配置多个 Agent / 模型变体。
              </p>
            )}
            {definition && (
              <>
                <p className="text-sm text-muted-foreground">
                  共同任务：{definition.goal}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {definition.parameters.map((p) => (
                    <ParameterInput
                      key={p.name}
                      parameter={p}
                      value={parameters[p.name] ?? ""}
                      change={(value) =>
                        setParameters((old) => ({ ...old, [p.name]: value }))
                      }
                    />
                  ))}
                </div>
              </>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {budgetFields.map((field) => (
                <Field key={field.key} label={field.label}>
                  <Input
                    type="number"
                    min={field.key === "maxConcurrent" ? 1 : variants.length}
                    max={field.max}
                    step={1}
                    value={budget[field.key]}
                    onChange={(e) =>
                      setBudget((old) => ({
                        ...old,
                        [field.key]: Number(e.target.value),
                      }))
                    }
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              创建时平均分配固定上限；每个变体最多 1 次运行、并发
              1。取整余量和未使用额度不会转给其他变体。
            </p>
            {variants.map((v, index) => (
              <article key={index} className="space-y-3 rounded-lg border p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Field label={`变体 ${index + 1} ID`}>
                    <Input
                      maxLength={64}
                      value={v.id}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (baseline === v.id) setBaseline(value);
                        changeVariant(index, { ...v, id: value });
                      }}
                    />
                  </Field>
                  <Field label="变体名称">
                    <Input
                      maxLength={200}
                      value={v.name}
                      onChange={(e) =>
                        changeVariant(index, { ...v, name: e.target.value })
                      }
                    />
                  </Field>
                  <Button
                    className="self-end"
                    size="sm"
                    variant="ghost"
                    disabled={variants.length <= 2 || busy}
                    onClick={() => {
                      const next = variants.filter((_, i) => i !== index);
                      setVariants(next);
                      if (baseline === v.id) setBaseline(next[0].id);
                    }}
                  >
                    移除
                  </Button>
                </div>
                {roles.map((role) => (
                  <div key={role} className="grid gap-3 sm:grid-cols-2">
                    <Field label={`${role} → Agent`}>
                      <NativeSelect
                        value={v.agentMapping[role] ?? ""}
                        onChange={(e) =>
                          changeVariant(index, {
                            ...v,
                            agentMapping: {
                              ...v.agentMapping,
                              [role]: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="">选择当前空间 Agent</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field
                      label={`${role} 模型选择器`}
                      hint="留空使用蓝图或租户默认模型；填写已配置的模型选择器。"
                    >
                      <Input
                        maxLength={256}
                        value={v.models?.[role] ?? ""}
                        onChange={(e) =>
                          changeVariant(index, {
                            ...v,
                            models: { ...v.models, [role]: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </div>
                ))}
              </article>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={variants.length >= 16 || busy}
                onClick={() => {
                  let index = variants.length + 1;
                  while (variants.some((v) => v.id === `variant_${index}`))
                    index++;
                  setVariants((old) => [
                    ...old,
                    variant(`variant_${index}`, `变体 ${index}`),
                  ]);
                }}
              >
                新增变体 ({variants.length}/16)
              </Button>
              <Field label="比较基准">
                <NativeSelect
                  value={baseline}
                  onChange={(e) => setBaseline(e.target.value)}
                >
                  {variants.map((v, i) => (
                    <option key={i} value={v.id}>
                      {v.name || v.id}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                size="sm"
                disabled={busy || !writable || !definition || !template}
                onClick={make}
              >
                创建独立草稿
              </Button>
            </div>
          </div>
        )}
        <Field label="本项目的实验活动">
          <NativeSelect
            value={current?.id ?? selection.current ?? ""}
            onChange={(e) => void choose(e.target.value)}
            disabled={busy}
          >
            <option value="">选择活动 ({items.length})</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.definition.name} · {item.status}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {current && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Status value={current.status} />
              <span>蓝图 v{current.definition.templateVersion}</span>
              <span>修订 {current.revision}</span>
              <span>源快照：{current.captureState}</span>
            </div>
            {current.baseSnapshot && (
              <p className="break-all text-xs text-muted-foreground">
                共同不可变快照：{current.baseSnapshot}
              </p>
            )}
            <ErrorNotice message={current.captureError ?? null} />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="mb-2 text-left text-xs text-muted-foreground">
                  固定预算预留；活动并发上限{" "}
                  {current.definition.budget.maxConcurrent}
                </caption>
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3">变体</th>
                    <th className="pr-3">Token</th>
                    <th className="pr-3">模型调用</th>
                    <th className="pr-3">工具调用</th>
                    <th>运行秒数</th>
                  </tr>
                </thead>
                <tbody>
                  {current.definition.variants.map((v) => (
                    <tr key={v.id} className="border-b">
                      <td className="py-2 pr-3">
                        {v.name}
                        {v.id === current.definition.baselineId
                          ? "（基准）"
                          : ""}
                      </td>
                      <td className="pr-3">
                        {v.project.config.budget.maxTokens.toLocaleString()}
                      </td>
                      <td className="pr-3">
                        {v.project.config.budget.maxModelCalls}
                      </td>
                      <td className="pr-3">
                        {v.project.config.budget.maxToolCalls}
                      </td>
                      <td>{v.project.config.budget.maxWallSeconds}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {human && (
              <div className="space-y-3 rounded-lg bg-muted/40 p-3">
                <Field
                  label="操作说明"
                  hint="说明本次冻结、启动、恢复检查或控制的原因，保存到活动审计记录。"
                >
                  <Textarea
                    rows={2}
                    maxLength={4096}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  确认冻结当前源文件或启动所选变体，会使用上述固定预算
                </label>
                <div className="flex flex-wrap gap-2">
                  {current.definition.variants.some(
                    (v) => v.state === "prepared",
                  ) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void operate(
                          () => campaignAction(current, "provision", comment),
                          "已检查并补齐记录中的草稿项目",
                        )
                      }
                    >
                      补齐草稿
                    </Button>
                  )}
                  {["unfrozen", "failed"].includes(current.captureState) && (
                    <Button
                      size="sm"
                      disabled={
                        !permitted || !confirmed || current.status !== "draft"
                      }
                      onClick={() =>
                        void operate(
                          () => campaignAction(current, "freeze", comment),
                          "源快照捕获与复制已返回，请检查各变体状态",
                        )
                      }
                    >
                      冻结共同源快照
                    </Button>
                  )}
                  {ambiguous && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!permitted}
                      onClick={() =>
                        void operate(
                          () => campaignAction(current, "inspect", comment),
                          "已读取持久回执和现有运行，未重复执行",
                        )
                      }
                    >
                      检查未决回执
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !permitted ||
                      ["cancelled", "provisioning", "controlling"].includes(
                        current.status,
                      )
                    }
                    onClick={() =>
                      void operate(
                        () => controlCampaign(current, "pause", comment),
                        "逐项暂停结果已记录",
                      )
                    }
                  >
                    逐项暂停
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !permitted ||
                      !["paused", "control_partial"].includes(current.status)
                    }
                    onClick={() =>
                      void operate(
                        () => controlCampaign(current, "resume", comment),
                        "逐项恢复结果已记录",
                      )
                    }
                  >
                    逐项恢复
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={
                      !permitted ||
                      ["cancelled", "provisioning", "controlling"].includes(
                        current.status,
                      )
                    }
                    onClick={() =>
                      void operate(
                        () => controlCampaign(current, "cancel", comment),
                        "逐项取消结果已记录",
                      )
                    }
                  >
                    逐项取消
                  </Button>
                </div>
              </div>
            )}
            {!human && (
              <p className="text-sm text-muted-foreground">
                冻结源文件、启动变体和控制运行需要具备写权限的真人会话。
              </p>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {current.definition.variants.map((v) => (
                <article key={v.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{v.name}</strong>
                    <Status value={v.state} />
                  </div>
                  <Link
                    className="text-sm text-primary underline"
                    href={`/dashboard/project-executions/${encodeURIComponent(v.project.id)}`}
                  >
                    打开独立项目
                  </Link>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {v.project.plan.tasks.map((task) => (
                      <li key={task.id}>
                        {task.title} ·{" "}
                        {agents.find((a) => a.id === task.agentId)?.name ??
                          task.agentId}{" "}
                        · {task.model || "默认模型"}
                      </li>
                    ))}
                  </ul>
                  {v.runId && (
                    <p className="break-all text-xs">固定运行 ID：{v.runId}</p>
                  )}
                  <ErrorNotice message={v.error ?? null} />
                  {human && (
                    <div className="flex flex-wrap gap-2">
                      {["provisioned", "copy_failed"].includes(v.state) &&
                        current.captureState === "ready" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!permitted}
                            onClick={() =>
                              void operate(
                                () =>
                                  campaignVariantAction(
                                    current,
                                    v.id,
                                    "copy",
                                    comment,
                                  ),
                                "共同快照复制结果已记录",
                              )
                            }
                          >
                            复制共同快照
                          </Button>
                        )}
                      {v.state === "ready" && (
                        <Button
                          size="sm"
                          disabled={
                            !permitted ||
                            !confirmed ||
                            !["draft", "active"].includes(current.status)
                          }
                          onClick={() =>
                            void operate(
                              () =>
                                campaignVariantAction(
                                  current,
                                  v.id,
                                  "start",
                                  comment,
                                ),
                              "启动结果已记录，运行使用共同源快照",
                            )
                          }
                        >
                          启动此变体
                        </Button>
                      )}
                      {v.state === "start_unknown" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            !permitted ||
                            !confirmed ||
                            current.status !== "active"
                          }
                          onClick={() =>
                            void operate(
                              () =>
                                campaignVariantAction(
                                  current,
                                  v.id,
                                  "retry-start",
                                  comment,
                                ),
                              "使用原有运行 ID 重试启动，未分配另一次运行",
                            )
                          }
                        >
                          按原 ID 重试启动
                        </Button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
            {comparison && (
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  比较结果：
                  {comparison.comparable
                    ? "任务与验收口径可比较"
                    : "存在影响可比性的差异"}
                </p>
                {comparison.reasons.map((reason, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {reason}
                  </p>
                ))}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="py-2 pr-3">变体 / 样本</th>
                        <th className="pr-3">必需验收通过</th>
                        <th className="pr-3">记账 Token</th>
                        <th className="pr-3">模型 / 工具调用</th>
                        <th>运行经过秒数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.measurements.map((m) => (
                        <tr key={m.variantId} className="border-b align-top">
                          <td className="py-2 pr-3">
                            {m.name} / {m.samples}
                            <div className="text-xs text-muted-foreground">
                              {m.status}
                            </div>
                          </td>
                          <td className="pr-3">
                            {m.acceptanceRate === null
                              ? "未知"
                              : `${(m.acceptanceRate * 100).toFixed(0)}%`}
                            <div className="text-xs">
                              {m.requiredChecksPassed}/{m.requiredChecksTotal}
                              ；已观察 {m.requiredChecksObserved}
                            </div>
                          </td>
                          <td className="pr-3">
                            {m.chargedTokens.toLocaleString()}
                            <div className="text-xs text-muted-foreground">
                              供应商实际报告：
                              {m.providerReportedTokens === null
                                ? "未知"
                                : m.providerReportedTokens.toLocaleString()}
                            </div>
                          </td>
                          <td className="pr-3">
                            {m.modelCalls} / {m.toolCalls}
                          </td>
                          <td>
                            {m.samples ? m.elapsedSeconds.toFixed(2) : "未知"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  记账 Token
                  包含执行器对未确认供应商响应的保守扣减；未推算费用。经过时间从创建运行开始，包含排队和暂停；结束样本截至最后持久更新时间。每个变体一次运行，样本不足以推断统计成功概率。
                </p>
                {comparison.measurements.some(
                  (m) => m.unknown.length || m.error,
                ) && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      查看证据缺口
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs">
                      {comparison.measurements.flatMap((m) =>
                        [...m.unknown, ...(m.error ? [m.error] : [])].map(
                          (text, i) => (
                            <li key={`${m.variantId}-${i}`}>
                              {m.name}：{text}
                            </li>
                          ),
                        ),
                      )}
                    </ul>
                  </details>
                )}
                {comparison.differences.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Agent / 模型与计划差异 ({comparison.differences.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {comparison.differences.map((d, i) => (
                        <p key={i} className="break-all text-xs">
                          {d.variantId} / {d.taskId} / {d.field}：{d.baseline} →{" "}
                          {d.candidate}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-sm">
                审计记录 ({audit.length})
              </summary>
              <div className="mt-3 space-y-3">
                {audit.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-lg border p-3 text-xs"
                  >
                    <div>
                      {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {item.action} {item.variantId}
                    </div>
                    <p className="my-2 whitespace-pre-wrap">{item.comment}</p>
                    <Code value={item.details} limit={6000} />
                  </article>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </Panel>
  );
}
