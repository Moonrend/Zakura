"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getCloudConfig, listChatModels, saveCloudConfig, type ChatModelOption } from "@/lib/cloud-agent";
import { useAgentDetail } from "@/components/agent-detail-context";
import { ModelRouteSelector, type ModelRouteSelectorItem } from "@/components/models/model-route-selector";
import { SettingsHeader, SettingsSaveIndicator, SettingsSection } from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageLoading } from "@/components/ui/progress-linear";

type BasicSettings = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  modelRouteId: string | null;
};

export default function AgentSettingsPage() {
  const { id, agent, refresh, patchAgent } = useAgentDetail();
  const [state, setState] = useState<BasicSettings | null>(null);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(null);
    setLoadError("");
    void Promise.all([refresh({ list: false }), getCloudConfig(id), listChatModels()])
      .then(([detail, config, available]) => {
        if (!alive) return;
        if (!detail) { setLoadError("加载 Agent 失败"); return; }
        setModels(available);
        setState({ name: detail.name, description: detail.description ?? "", systemPrompt: config.cloud.systemPrompt ?? "", model: config.cloud.model ?? "", modelRouteId: config.cloud.modelRouteId ?? null });
      }).catch(err => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [id, refresh, reload]);

  const persist = useCallback(async (patch: Partial<BasicSettings>) => {
    const metadata: { name?: string; description?: string } = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error("名称不能为空");
      metadata.name = patch.name.trim();
    }
    if (patch.description !== undefined) metadata.description = patch.description;
    if (Object.keys(metadata).length) {
      await api(`/api/agents/${encodeURIComponent(id)}`, { method: "PATCH", json: metadata });
      patchAgent(metadata);
    }
    const cloud: Parameters<typeof saveCloudConfig>[1] = {};
    if (patch.systemPrompt !== undefined) cloud.systemPrompt = patch.systemPrompt;
    if (patch.model !== undefined) cloud.model = patch.model || null;
    if (patch.modelRouteId !== undefined) cloud.modelRouteId = patch.modelRouteId;
    if (Object.keys(cloud).length) await saveCloudConfig(id, cloud);
  }, [id, patchAgent]);
  const { status, error, schedule, saveNow } = useAutoSave(persist, { debounceMs: 550 });
  const items = useMemo<ModelRouteSelectorItem[]>(() => {
    const available = models.map(m => ({ value: m.alias, label: m.name, hint: m.upstream, providers: m.providers }));
    if (state?.model && !available.some(m => m.value === state.model)) available.push({ value: state.model, label: state.model, hint: undefined, providers: [] });
    return available;
  }, [models, state?.model]);

  function update(key: "name" | "description" | "systemPrompt", value: string) {
    setState(current => current ? { ...current, [key]: value } : current);
    schedule({ [key]: value });
  }
  if (!agent || !state) return loadError ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重试</Button></div> : <PageLoading />;
  return <div className="space-y-5">
    <SettingsHeader title="设置" actions={<SettingsSaveIndicator status={status} error={error} />} />
    <SettingsSection title="基本">
      <div className="space-y-4">
        <div className="space-y-1.5"><label htmlFor="agent-name" className="text-sm font-medium">名称</label><Input id="agent-name" value={state.name} onChange={event => update("name", event.target.value)} /></div>
        <div className="space-y-1.5"><label htmlFor="agent-description" className="text-sm font-medium">描述</label><Textarea id="agent-description" rows={2} value={state.description} onChange={event => update("description", event.target.value)} /></div>
        <div className="space-y-1.5"><label htmlFor="agent-system-prompt" className="text-sm font-medium">系统提示词</label><Textarea id="agent-system-prompt" rows={5} value={state.systemPrompt} onChange={event => update("systemPrompt", event.target.value)} /></div>
        <div className="space-y-1.5"><label className="text-sm font-medium">模型</label>
          <ModelRouteSelector items={items} value={state.model || models.find(m => m.isDefault)?.alias || ""} routeId={state.modelRouteId} onSelectionChange={(model, modelRouteId) => {
            if (!model) return;
            setState(current => current ? { ...current, model, modelRouteId } : current);
            saveNow({ model, modelRouteId });
          }} disabled={!models.length} placeholder={!models.length ? "暂无模型" : "选择模型"} className="h-9 w-full max-w-none justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground" />
        </div>
      </div>
    </SettingsSection>
  </div>;
}
