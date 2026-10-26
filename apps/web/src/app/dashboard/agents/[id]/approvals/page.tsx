"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { parseToolApprovalConfig, resolveApprovalPolicy, type ToolApprovalConfig, type ToolApprovalPolicy } from "@zakura/shared";
import { getCloudConfig, listModelsByCapability, saveCloudConfig, type ChatModelOption } from "@/lib/cloud-agent";
import { useAgentDetail } from "@/components/agent-detail-context";
import { ModelRouteSelector } from "@/components/models/model-route-selector";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageLoading } from "@/components/ui/progress-linear";
import { SettingsHeader, SettingsRow, SettingsSaveIndicator, SettingsSection } from "@/components/settings-shell";

const POLICIES: Array<{ value: ToolApprovalPolicy; label: string }> = [
  { value: "allow_all", label: "自动允许" },
  { value: "always_ask", label: "始终审批" },
  { value: "ai", label: "AI 审批" },
];

export default function AgentApprovalsPage() {
  const { id, agent } = useAgentDetail();
  const [config, setConfig] = useState<ToolApprovalConfig | null>(null);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const persist = useCallback(async (patch: Partial<ToolApprovalConfig>) => {
    await saveCloudConfig(id, { approvals: patch });
  }, [id]);
  const { status, error, saveNow } = useAutoSave(persist);
  useEffect(() => {
    let alive = true;
    setConfig(null);
    setLoadError("");
    void Promise.all([getCloudConfig(id), listModelsByCapability("evaluation")]).then(([result, available]) => {
      if (!alive) return;
      setConfig(parseToolApprovalConfig(result.cloud.approvals));
      setModels(available);
    }).catch(err => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [id, reload]);
  if (!config) return loadError ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重试</Button></div> : <PageLoading />;
  const policy = resolveApprovalPolicy(config);
  const gate = config.aiGate;
  // One item per concrete route: even a single-provider selection must retain an ID.
  const items = models.flatMap(model => model.providers.map(route => ({ value: route.id, label: model.name, hint: route.name, keywords: [model.alias, route.name] })));
  const legacyModel = models.find(model => model.alias === gate?.routeAlias);
  const selectedId = gate?.routeId ?? (legacyModel?.providers.length === 1 ? legacyModel.providers[0]?.id : undefined);
  const legacy = !gate?.routeId && !gate?.routeAlias && (gate?.provider === "llm" || gate?.llmModel);
  return <div className="space-y-5">
    <SettingsHeader title="工具审批" actions={<SettingsSaveIndicator status={status} error={error} />} />
    <SettingsSection title="审批">
      <SettingsRow label="策略">
        <Select value={policy} items={POLICIES} onValueChange={value => {
          if (value !== "allow_all" && value !== "always_ask" && value !== "ai") return;
          setConfig(current => current ? { ...current, policy: value } : current);
          saveNow({ policy: value });
        }}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{POLICIES.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsRow>
      {policy === "ai" ? <>
        <SettingsRow label="审批范围" description="默认继承 Space：自动允许已知只读请求，其他调用交给 AI。通过后直接执行。">
          <Select value={gate?.scope ?? "inherit"} items={[{ value: "inherit", label: "继承 Space" }, { value: "risky", label: "有风险或未知的调用" }, { value: "all", label: "全部调用" }]} onValueChange={scope => {
            if (scope !== "inherit" && scope !== "risky" && scope !== "all") return;
            setConfig(current => current ? { ...current, aiGate: { ...current.aiGate, scope } } : current);
            saveNow({ aiGate: { scope } });
          }}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="inherit">继承 Space</SelectItem><SelectItem value="risky">有风险或未知的调用</SelectItem><SelectItem value="all">全部调用</SelectItem></SelectContent>
          </Select>
        </SettingsRow>
        {agent?.spaceId ? <Link href={`/dashboard/spaces/${agent.spaceId}/settings/approvals`} className="text-xs text-muted-foreground underline underline-offset-4">配置 Space 的只读与危险工具范围</Link> : null}
        <SettingsRow label="审批模型">
          <ModelRouteSelector items={items} value={selectedId} placeholder={legacy ? `原模型：${gate?.llmModel || "传统模型"}` : selectedId ? "已选模型不可用" : "选择模型"} disabled={!items.length} onSelectionChange={routeId => {
            const model = models.find(item => item.providers.some(route => route.id === routeId));
            if (!routeId || !model) return;
            const aiGate = { provider: "jev" as const, routeId, routeAlias: model.alias };
            setConfig(current => current ? { ...current, aiGate: { ...current.aiGate, ...aiGate } } : current);
            saveNow({ aiGate });
          }} />
        </SettingsRow>
        {legacy ? <p className="text-xs text-muted-foreground">保留原模型审批；选择新模型后才会替换。</p> : null}
        {!items.length ? <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/dashboard/models/upstreams?provider=typesafe" />}>添加 Jev</Button> : null}
      </> : null}
    </SettingsSection>
  </div>;
}
