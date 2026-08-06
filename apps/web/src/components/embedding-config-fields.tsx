"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ModelRouteSelector,
  type ModelRouteSelectorItem,
} from "@/components/models/model-route-selector";
import { listModelsByCapability, type ChatModelOption } from "@/lib/cloud-agent";
import { cn } from "@/lib/utils";

export type EmbeddingRoute = {
  id: string;
  name: string;
  slug: string;
  model: string;
  isDefault: boolean;
  options?: { dimensions?: number };
  upstream?: { name?: string; protocol?: string };
};

/** Built-in 向量只走模型路由，不再手填 baseUrl / model */
export type EmbeddingFormValue = {
  enabled: boolean;
  /** 逻辑模型 alias；空表示沿用团队默认 */
  model: string;
  /** 固定上游部署；null 表示该 alias 下自动路由 */
  routeId: string | null;
};

export function embeddingFromConfig(
  emb: Record<string, unknown>,
  models: ChatModelOption[],
): EmbeddingFormValue {
  const routeId = typeof emb.routeId === "string" ? emb.routeId.trim() : "";
  const routeSlug = typeof emb.routeSlug === "string" ? emb.routeSlug.trim() : "";

  if (routeId) {
    const matched = models.find((m) => m.providers.some((p) => p.id === routeId));
    return {
      enabled: emb.enabled === true,
      model: matched?.alias ?? routeSlug,
      routeId,
    };
  }

  if (routeSlug) {
    return {
      enabled: emb.enabled === true,
      model: routeSlug,
      routeId: null,
    };
  }

  const fallback = models.find((m) => m.isDefault) ?? models[0];
  return {
    enabled: emb.enabled === true,
    model: fallback?.alias ?? "",
    routeId: fallback?.defaultRouteId ?? null,
  };
}

export function embeddingToConfig(value: EmbeddingFormValue): Record<string, unknown> {
  const base: Record<string, unknown> = { enabled: value.enabled };
  if (!value.enabled) return base;
  if (value.routeId) {
    base.routeId = value.routeId;
  } else if (value.model) {
    base.routeSlug = value.model;
  }
  return base;
}

export function embeddingSummary(
  config: Record<string, unknown>,
  models: ChatModelOption[],
): string | null {
  const emb =
    config.embedding && typeof config.embedding === "object"
      ? (config.embedding as Record<string, unknown>)
      : null;
  if (!emb || emb.enabled !== true) return null;

  const routeId = typeof emb.routeId === "string" ? emb.routeId : "";
  const routeSlug = typeof emb.routeSlug === "string" ? emb.routeSlug : "";
  const byRoute = routeId
    ? models.find((m) => m.providers.some((p) => p.id === routeId))
    : undefined;
  const byAlias = routeSlug ? models.find((m) => m.alias === routeSlug) : undefined;
  const model = byRoute ?? byAlias ?? models.find((m) => m.isDefault);

  if (model) return `向量 · ${model.name}`;
  if (!routeId && !routeSlug) return "向量 · 团队默认";
  return "向量 · 已选模型";
}

type Props = {
  value: EmbeddingFormValue;
  onChange: (next: EmbeddingFormValue) => void;
  models: ChatModelOption[];
  modelsLoading?: boolean;
  onReloadModels?: () => void;
  className?: string;
};

export function EmbeddingConfigFields({
  value,
  onChange,
  models,
  modelsLoading = false,
  onReloadModels,
  className,
}: Props) {
  const patch = (p: Partial<EmbeddingFormValue>) => onChange({ ...value, ...p });
  const hasModels = models.length > 0;

  const items = useMemo<ModelRouteSelectorItem[]>(
    () =>
      models.map((m) => ({
        value: m.alias,
        label: m.name,
        hint: m.upstream,
        keywords: [m.alias, m.upstream ?? ""].filter(Boolean),
        providers: m.providers,
      })),
    [models],
  );

  const displayModel =
    value.model || models.find((m) => m.isDefault)?.alias || models[0]?.alias || "";

  const selected = models.find((m) => m.alias === displayModel) ?? null;
  const selectedProvider = value.routeId
    ? selected?.providers.find((p) => p.id === value.routeId)
    : undefined;

  return (
    <div className={cn("space-y-3 rounded-lg border border-border p-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>启用向量语义种子</Label>
          <p className="text-xs text-muted-foreground">
            与关键词、图谱混合召回；从已配置的 embedding 模型中选择
          </p>
        </div>
        <Switch
          checked={value.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </div>

      {value.enabled ? (
        <div className="space-y-2">
          {modelsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载 embedding 模型…
            </div>
          ) : !hasModels ? (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <p className="text-muted-foreground">
                尚未配置 embedding 模型。请先在上游中同步或添加向量模型。
              </p>
              <Link
                href="/dashboard/models/upstreams"
                className="mt-1 inline-flex items-center text-sm text-primary underline-offset-4 hover:underline"
              >
                前往上游
                <ExternalLink className="ml-1 size-3" />
              </Link>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Embedding 模型</Label>
                <ModelRouteSelector
                  items={items}
                  value={displayModel}
                  routeId={value.routeId}
                  onSelectionChange={(alias, routeId) => {
                    if (!alias) return;
                    patch({ model: alias, routeId });
                  }}
                  className="h-9 max-w-none w-full justify-between rounded-md border border-input bg-transparent px-3 font-normal text-foreground"
                  placeholder="选择模型"
                />
              </div>

              {selected ? (
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <div>
                    调用名{" "}
                    <span className="font-mono text-foreground">{selected.alias}</span>
                  </div>
                  {selectedProvider ? (
                    <div>
                      上游{" "}
                      <span className="text-foreground">{selectedProvider.name}</span>
                    </div>
                  ) : selected.upstream ? (
                    <div>
                      路由{" "}
                      <span className="text-foreground">自动 · {selected.upstream}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>API Key 与端点由上游统一管理，无需手填</span>
                {onReloadModels ? (
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onReloadModels()}
                  >
                    刷新列表
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function useEmbeddingModels() {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setModels(await listModelsByCapability("embedding"));
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { models, loading, reload: load };
}

/** @deprecated 使用 useEmbeddingModels */
export function useEmbeddingRoutes() {
  const { models, loading, reload } = useEmbeddingModels();
  const routes = useMemo<EmbeddingRoute[]>(
    () =>
      models.flatMap((m) =>
        m.providers.map((p) => ({
          id: p.id,
          name: m.name,
          slug: m.alias,
          model: m.alias,
          isDefault: Boolean(m.isDefault && (!m.defaultRouteId || m.defaultRouteId === p.id)),
          upstream: { name: p.name },
        })),
      ),
    [models],
  );
  return { routes, loading, reload };
}

export function validateEmbeddingForm(
  value: EmbeddingFormValue,
  models: ChatModelOption[],
): string | null {
  if (!value.enabled) return null;
  if (models.length === 0) {
    return "暂无 embedding 模型，请先在上游配置并同步向量模型";
  }
  if (!value.model) return "请选择 embedding 模型";
  if (!models.some((m) => m.alias === value.model)) {
    return "请选择已有的 embedding 模型";
  }
  if (value.routeId && !models.some((m) => m.providers.some((p) => p.id === value.routeId))) {
    return "请选择已有的 embedding 模型";
  }
  return null;
}

/** @deprecated 已移除哨兵值 */
export const DEFAULT_ROUTE = "";
