"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/components/me-context";
import {
  subscribePlatformEvents,
  type PlatformServiceProgressSnapshot,
} from "@/lib/platform-events";
import { SettingsHeader } from "@/components/settings-shell";
import { PlatformTransactionalEmailPanel } from "@/components/platform-transactional-email-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressLinear } from "@/components/ui/progress-linear";
import { cn } from "@/lib/utils";

type LifecycleView = {
  state: string;
  label: string;
  detail: string;
  tone: "neutral" | "info" | "success" | "warn" | "danger";
  busy: boolean;
  actions: string[];
};

type PlatformService = {
  key: string;
  name: string;
  description: string;
  mapsTo: { kind: string; id: string };
  mode: "disabled" | "managed" | "external";
  status: string;
  healthStatus: string;
  endpointUrl: string | null;
  lastError: string | null;
  containers: Array<{ name: string; dockerId: string | null; role: string }>;
  config: {
    image?: string;
    hostPort?: number;
    hasApiKey: boolean;
  };
  catalogDefaultImage?: string;
  catalogDefaultHostPort?: number;
  lifecycle: LifecycleView;
  progress: PlatformServiceProgressSnapshot;
};

type ListPayload = {
  services: PlatformService[];
  canManage: boolean;
};

const TONE_BADGE: Record<LifecycleView["tone"], string> = {
  neutral: "",
  info: "text-muted-foreground",
  success: "border-success/40 text-success",
  warn: "border-warning/40 text-warning-foreground",
  danger: "border-destructive/50 text-destructive",
};

function progressLog(progress: PlatformServiceProgressSnapshot | undefined): string {
  if (!progress?.events?.length) return "";
  return progress.events.map((e) => e.message).join("\n");
}

export default function PlatformServicesPage() {
  const me = useMe();
  const router = useRouter();
  const [data, setData] = useState<ListPayload | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState<Record<string, boolean>>({});
  const [showLog, setShowLog] = useState<Record<string, boolean>>({});
  const [liveLogs, setLiveLogs] = useState<Record<string, string>>({});
  const [containerLogs, setContainerLogs] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<
    Record<string, { hostPort: string; image: string }>
  >({});
  const logRefs = useRef<Record<string, HTMLPreElement | null>>({});

  useEffect(() => {
    if (me.multiTenant && !me.isPlatformAdmin) {
      setForbidden(true);
      router.replace("/dashboard");
    }
  }, [me.multiTenant, me.isPlatformAdmin, router]);

  const load = useCallback(async () => {
    try {
      const res = await api<ListPayload>("/api/platform-services");
      setData(res);
      setForbidden(false);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const s of res.services) {
          next[s.key] = {
            hostPort:
              s.config.hostPort != null
                ? String(s.config.hostPort)
                : (prev[s.key]?.hostPort ?? ""),
            image: s.config.image ?? prev[s.key]?.image ?? "",
          };
        }
        return next;
      });
      setLiveLogs((prev) => {
        const next = { ...prev };
        for (const s of res.services) {
          const t = progressLog(s.progress);
          if (t) next[s.key] = t;
        }
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|Forbidden/i.test(msg)) {
        setForbidden(true);
        return;
      }
      toast.error(msg);
    }
  }, []);

  useEffect(() => {
    if (me.multiTenant && !me.isPlatformAdmin) return;
    void load();
  }, [load, me.multiTenant, me.isPlatformAdmin]);

  useEffect(() => {
    if (me.multiTenant && !me.isPlatformAdmin) return;
    return subscribePlatformEvents(
      (ev) => {
        if (ev.type !== "platform_service_progress") return;
        setLiveLogs((prev) => ({
          ...prev,
          [ev.serviceKey]: progressLog(ev.snapshot),
        }));
        setShowLog((p) => ({ ...p, [ev.serviceKey]: true }));
        if (ev.snapshot.done || !ev.snapshot.running) {
          void load();
        } else {
          setData((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              services: prev.services.map((s) =>
                s.key === ev.serviceKey
                  ? {
                      ...s,
                      progress: ev.snapshot,
                      lifecycle: {
                        ...s.lifecycle,
                        busy: ev.snapshot.running,
                        label: ev.snapshot.phase || s.lifecycle.label,
                        detail: ev.snapshot.message || s.lifecycle.detail,
                      },
                    }
                  : s,
              ),
            };
          });
        }
      },
      () => void load(),
    );
  }, [load, me.multiTenant, me.isPlatformAdmin]);

  const anyBusy = useMemo(
    () => data?.services.some((s) => s.lifecycle.busy || s.progress?.running) ?? false,
    [data],
  );

  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [anyBusy, load]);

  useEffect(() => {
    for (const [key, el] of Object.entries(logRefs.current)) {
      if (el && (liveLogs[key] || containerLogs[key])) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [liveLogs, containerLogs]);

  async function runAction(key: string, path: string) {
    setActionKey(key);
    try {
      await api(`/api/platform-services/${key}/${path}`, { method: "POST" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setActionKey(null);
    }
  }

  async function fetchLogs(key: string) {
    try {
      const res = await api<{ logs: string }>(
        `/api/platform-services/${key}/logs?tail=200`,
      );
      setContainerLogs((p) => ({ ...p, [key]: res.logs || "(empty)" }));
      setShowLog((p) => ({ ...p, [key]: true }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveConfig(key: string) {
    const d = drafts[key];
    if (!d) return;
    setActionKey(key);
    try {
      const hostPort = d.hostPort.trim() ? Number(d.hostPort) : undefined;
      await api(`/api/platform-services/${key}`, {
        method: "PATCH",
        json: {
          config: {
            hostPort: Number.isFinite(hostPort) ? hostPort : undefined,
            image: d.image.trim() || undefined,
          },
        },
      });
      toast.success("已保存");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActionKey(null);
    }
  }

  if (forbidden || (me.multiTenant && !me.isPlatformAdmin)) {
    return (
      <div className="space-y-2 p-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">自托管服务</h1>
        <p className="text-sm text-muted-foreground">
          仅主机管理员可管理 Docker 服务。团队成员请在「网页」中选用已托管的能力。
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="自托管服务"
        description="本机 Docker · 部署后在「网页」中选用"
        actions={
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        }
      />

      {!me.multiTenant ? <PlatformTransactionalEmailPanel /> : null}

      <div className="divide-y rounded-lg border border-border bg-card">
        {data.services.map((s) => {
          const lc = s.lifecycle;
          const busy = Boolean(actionKey === s.key || lc.busy || s.progress?.running);
          const progressText = liveLogs[s.key] || progressLog(s.progress);
          const d = drafts[s.key] ?? { hostPort: "", image: "" };
          const actions = new Set(lc.actions);
          const logOpen = showLog[s.key] || busy;
          const cfgOpen = showConfig[s.key];
          const logBody = containerLogs[s.key]
            ? containerLogs[s.key]
            : progressText;

          return (
            <section key={s.key} className="p-4">
              {busy ? (
                <div className="-mx-4 -mt-4 mb-3">
                  <ProgressLinear
                    flush
                    indeterminate={(s.progress?.percent ?? 0) < 8}
                    value={s.progress?.percent || null}
                  />
                </div>
              ) : null}

              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold tracking-tight">{s.name}</h2>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", TONE_BADGE[lc.tone])}
                    >
                      {lc.label}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                  {(lc.detail || s.endpointUrl) && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {lc.detail || s.endpointUrl}
                    </p>
                  )}
                  {s.lastError && lc.state === "failed" ? (
                    <p className="text-xs text-destructive">{s.lastError}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {(actions.has("deploy") ||
                    actions.has("start") ||
                    actions.has("retry")) && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void runAction(
                          s.key,
                          actions.has("deploy") || actions.has("retry")
                            ? "deploy"
                            : "start",
                        )
                      }
                    >
                      {busy && actionKey === s.key ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : null}
                      {lc.state === "failed"
                        ? "重试"
                        : lc.state === "ready"
                          ? "启动"
                          : "部署"}
                    </Button>
                  )}
                  {actions.has("stop") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void runAction(s.key, "stop")}
                    >
                      停止
                    </Button>
                  )}
                  {actions.has("restart") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void runAction(s.key, "restart")}
                    >
                      重启
                    </Button>
                  )}
                  {actions.has("health") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void runAction(s.key, "health")}
                    >
                      检查
                    </Button>
                  )}
                  {actions.has("disable") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void runAction(s.key, "disable")}
                    >
                      停用
                    </Button>
                  )}
                  {s.containers.some((c) => c.dockerId) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void fetchLogs(s.key)}
                    >
                      <ScrollText className="size-3.5" />
                      日志
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setShowConfig((p) => ({ ...p, [s.key]: !p[s.key] }))
                    }
                  >
                    {cfgOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    镜像/端口
                  </Button>
                </div>
              </div>

              {/* Single log pane: progress during deploy, container logs on demand */}
              {logOpen && logBody ? (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {containerLogs[s.key] ? "容器日志" : "部署日志"}
                    </span>
                    {!busy && (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setShowLog((p) => ({ ...p, [s.key]: false }))
                        }
                      >
                        收起
                      </button>
                    )}
                  </div>
                  <pre
                    ref={(el) => {
                      logRefs.current[s.key] = el;
                    }}
                    className={cn(
                      "max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2.5",
                      "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
                    )}
                  >
                    {logBody}
                  </pre>
                </div>
              ) : null}

              {cfgOpen && (
                <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">镜像</Label>
                    <Input
                      className="font-mono text-xs"
                      value={d.image}
                      placeholder={s.catalogDefaultImage}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [s.key]: { ...d, image: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">主机端口</Label>
                    <Input
                      className="font-mono text-xs"
                      value={d.hostPort}
                      placeholder={
                        s.catalogDefaultHostPort != null
                          ? String(s.catalogDefaultHostPort)
                          : ""
                      }
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [s.key]: { ...d, hostPort: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void saveConfig(s.key)}
                    >
                      保存
                    </Button>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      仅写配置，不会自动部署 · 网页侧映射{" "}
                      {s.mapsTo.kind}/{s.mapsTo.id}
                    </span>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
