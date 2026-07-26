"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  /** 选中的上游模型 id；`__default__` 表示租户默认 embedding */
  routeId: string;
};

const DEFAULT_ROUTE = "__default__";

export function embeddingFromConfig(
  emb: Record<string, unknown>,
  routes: EmbeddingRoute[],
): EmbeddingFormValue {
  const routeId = typeof emb.routeId === "string" ? emb.routeId.trim() : "";
  const routeSlug = typeof emb.routeSlug === "string" ? emb.routeSlug.trim() : "";
  const matchedBySlug = routeSlug
    ? routes.find((r) => r.slug === routeSlug)
    : undefined;

  let resolvedRouteId = DEFAULT_ROUTE;
  if (routeId && routes.some((r) => r.id === routeId)) {
    resolvedRouteId = routeId;
  } else if (matchedBySlug) {
    resolvedRouteId = matchedBySlug.id;
  } else if (routeId) {
    // 配置里仍有 routeId，但列表尚未加载完时先保留
    resolvedRouteId = routeId;
  } else if (routes.find((r) => r.isDefault)) {
    resolvedRouteId = routes.find((r) => r.isDefault)!.id;
  }

  return {
    enabled: emb.enabled === true,
    routeId: resolvedRouteId,
  };
}

export function embeddingToConfig(value: EmbeddingFormValue): Record<string, unknown> {
  const base: Record<string, unknown> = { enabled: value.enabled };
  if (!value.enabled) return base;
  if (value.routeId && value.routeId !== DEFAULT_ROUTE) {
    base.routeId = value.routeId;
  }
  return base;
}

export function embeddingSummary(
  config: Record<string, unknown>,
  routes: EmbeddingRoute[],
): string | null {
  const emb =
    config.embedding && typeof config.embedding === "object"
      ? (config.embedding as Record<string, unknown>)
      : null;
  if (!emb || emb.enabled !== true) return null;

  const routeId = typeof emb.routeId === "string" ? emb.routeId : "";
  const routeSlug = typeof emb.routeSlug === "string" ? emb.routeSlug : "";
  const route =
    routes.find((r) => r.id === routeId) ??
    routes.find((r) => r.slug === routeSlug);

  if (route) return `向量 · ${route.name}`;
  if (!routeId && !routeSlug) return "向量 · 默认模型";
  return "向量 · 已选模型";
}

type Props = {
  value: EmbeddingFormValue;
  onChange: (next: EmbeddingFormValue) => void;
  routes: EmbeddingRoute[];
  routesLoading?: boolean;
  onReloadRoutes?: () => void;
  className?: string;
};

export function EmbeddingConfigFields({
  value,
  onChange,
  routes,
  routesLoading = false,
  onReloadRoutes,
  className,
}: Props) {
  const patch = (p: Partial<EmbeddingFormValue>) => onChange({ ...value, ...p });
  const hasRoutes = routes.length > 0;

  const routeItems = useMemo(
    () => [
      {
        value: DEFAULT_ROUTE,
        label: `租户默认（${routes.find((r) => r.isDefault)?.name ?? "按权重自动选择"}）`,
      },
      ...routes.map((r) => ({
        value: r.id,
        label: `${r.name}${r.isDefault ? " · 默认" : ""} · ${r.model}`,
      })),
    ],
    [routes],
  );

  const selectedRoute = useMemo(() => {
    if (value.routeId === DEFAULT_ROUTE) {
      return routes.find((r) => r.isDefault) ?? routes[0] ?? null;
    }
    return routes.find((r) => r.id === value.routeId) ?? null;
  }, [routes, value.routeId]);

  const selectValue =
    value.routeId &&
    (value.routeId === DEFAULT_ROUTE || routes.some((r) => r.id === value.routeId))
      ? value.routeId
      : DEFAULT_ROUTE;

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
          {routesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              加载 embedding 模型…
            </div>
          ) : !hasRoutes ? (
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
              <div>
                <Label>Embedding 模型</Label>
                <Select
                  value={selectValue}
                  onValueChange={(v) => {
                    if (v) patch({ routeId: v });
                  }}
                  items={routeItems}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder="选择已有模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {routeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedRoute ? (
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <div>
                    调用名{" "}
                    <span className="font-mono text-foreground">{selectedRoute.model}</span>
                  </div>
                  {selectedRoute.upstream?.name ? (
                    <div>
                      上游{" "}
                      <span className="text-foreground">{selectedRoute.upstream.name}</span>
                    </div>
                  ) : null}
                  {selectedRoute.options?.dimensions ? (
                    <div>
                      维度{" "}
                      <span className="text-foreground">
                        {selectedRoute.options.dimensions}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>API Key 与端点由上游统一管理，无需手填</span>
                {onReloadRoutes ? (
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onReloadRoutes()}
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

export function useEmbeddingRoutes() {
  const [routes, setRoutes] = useState<EmbeddingRoute[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ routes: EmbeddingRoute[] }>(
        "/api/model-routes?capability=embedding",
      );
      setRoutes(res.routes ?? []);
    } catch {
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { routes, loading, reload: load };
}

export function validateEmbeddingForm(
  value: EmbeddingFormValue,
  routes: EmbeddingRoute[],
): string | null {
  if (!value.enabled) return null;
  if (routes.length === 0) {
    return "暂无 embedding 模型，请先在上游配置并同步向量模型";
  }
  if (value.routeId === DEFAULT_ROUTE) return null;
  if (!value.routeId || !routes.some((r) => r.id === value.routeId)) {
    return "请选择已有的 embedding 模型";
  }
  return null;
}

export { DEFAULT_ROUTE };
