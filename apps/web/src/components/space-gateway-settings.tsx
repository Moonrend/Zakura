"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { listChatModels, type ChatModelOption } from "@/lib/cloud-agent";
import { ModelRouteSelector, type ModelRouteSelectorItem } from "@/components/models/model-route-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";

type ModelMapRow = { id: string; from: string; to: string };
type GatewayConfig = {
  cloud: {
    model?: string;
    modelRouteId?: string | null;
    gatewayModelMap?: Record<string, string>;
  };
};

export function SpaceGatewaySettings({ spaceId }: { spaceId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelRouteId, setModelRouteId] = useState<string | null>(null);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [mapRows, setMapRows] = useState<ModelMapRow[]>([]);
  const mapRowsRef = useRef(mapRows);
  mapRowsRef.current = mapRows;
  const [saving, setSaving] = useState(false);
  const [savingMap, setSavingMap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<GatewayConfig>(`/api/spaces/${spaceId}/gateway/config`),
      listChatModels(),
    ]).then(([config, models]) => {
      if (cancelled) return;
      setModel(config.cloud.model ?? "");
      setModelRouteId(config.cloud.modelRouteId ?? null);
      setMapRows(Object.entries(config.cloud.gatewayModelMap ?? {}).map(([from, to], i) => ({ id: `${i}-${from}`, from, to })));
      setChatModels(models);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [spaceId]);

  const modelItems = useMemo<ModelRouteSelectorItem[]>(() => chatModels.map((item) => ({
    value: item.alias,
    label: item.name || item.alias,
    hint: item.providers.map((provider) => provider.name).join(" / ") || item.upstream,
    providers: item.providers,
    reasoning: item.reasoning,
    reasoningLevels: item.reasoningLevels,
    defaultReasonLevel: item.defaultReasonLevel,
  })), [chatModels]);

  async function saveModel(alias: string, routeId: string | null) {
    const previous = { model, modelRouteId };
    setModel(alias);
    setModelRouteId(routeId);
    setSaving(true);
    try {
      await api(`/api/spaces/${spaceId}/gateway/config`, {
        method: "PUT", json: { model: alias || null, modelRouteId: routeId },
      });
    } catch (err) {
      setModel(previous.model);
      setModelRouteId(previous.modelRouteId);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveMap(rows: ModelMapRow[]) {
    const gatewayModelMap: Record<string, string> = {};
    for (const row of rows) {
      if (row.from.trim() && row.to.trim()) gatewayModelMap[row.from.trim()] = row.to.trim();
    }
    setSavingMap(true);
    try {
      await api(`/api/spaces/${spaceId}/gateway/config`, {
        method: "PUT", json: { gatewayModelMap: Object.keys(gatewayModelMap).length ? gatewayModelMap : null },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMap(false);
    }
  }

  function updateRow(id: string, patch: Partial<Pick<ModelMapRow, "from" | "to">>) {
    setMapRows((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  if (loading) return <PageLoading />;
  if (error) return <p role="alert" className="text-sm text-muted-foreground">模型设置加载失败：{error}</p>;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>默认模型</Label>
        <ModelRouteSelector
          items={modelItems}
          value={model || chatModels.find((item) => item.isDefault)?.alias || ""}
          routeId={modelRouteId}
          onSelectionChange={(alias, routeId) => { if (alias) void saveModel(alias, routeId); }}
          disabled={!chatModels.length || saving}
          placeholder={chatModels.length ? "选择模型" : "暂无模型"}
          className="h-9 w-full max-w-none justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
        />
      </div>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">模型名转发</p>
            <p className="text-xs text-muted-foreground">将客户端的模型名转发到指定模型。</p>
          </div>
          <Button size="sm" variant="ghost" disabled={savingMap} onClick={() => {
            setMapRows((rows) => [...rows, { id: crypto.randomUUID(), from: "", to: "" }]);
          }}>
            <Plus className="size-3.5" />添加
          </Button>
        </div>
        {mapRows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              aria-label="客户端模型名"
              value={row.from}
              placeholder="客户端模型名"
              className="min-w-0 font-mono text-xs"
              onChange={(event) => updateRow(row.id, { from: event.target.value })}
              onBlur={() => void saveMap(mapRowsRef.current)}
            />
            <span aria-hidden="true" className="text-xs text-muted-foreground">→</span>
            <Input
              aria-label="实际模型名"
              value={row.to}
              placeholder="实际模型名"
              className="min-w-0 font-mono text-xs"
              onChange={(event) => updateRow(row.id, { to: event.target.value })}
              onBlur={() => void saveMap(mapRowsRef.current)}
            />
            <Button size="icon-sm" variant="ghost" disabled={savingMap} aria-label="删除转发" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => {
              const next = mapRowsRef.current.filter((item) => item.id !== row.id);
              setMapRows(next);
              void saveMap(next);
            }}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {!mapRows.length ? <p className="text-xs text-muted-foreground">未设置时，使用客户端请求的模型名。</p> : null}
      </div>
    </div>
  );
}
