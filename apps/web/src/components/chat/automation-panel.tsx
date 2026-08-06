"use client";

/**
 * 对话侧栏 · 任务面板
 * 任务按「内容」展示（名称 + 指令摘要 + 安静的时间元信息），
 * 避免表格/徽章墙/三栏统计那种机械列表感。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type AgentHeartbeat,
  type AgentSchedule,
  type AutomationRun,
  type WhenPresetId,
  HEARTBEAT_INTERVAL_OPTIONS,
  WHEN_PRESETS,
  PROMPT_EXAMPLES,
  createSchedule,
  deleteSchedule,
  describePattern,
  formatRelativeTime,
  getHeartbeat,
  listAutomationRuns,
  listSchedules,
  patternFromWhenPreset,
  runHeartbeatNow,
  runScheduleNow,
  saveHeartbeat,
  updateSchedule,
  whenPresetFromPattern,
} from "@/lib/automation";

type FormState = {
  name: string;
  preset: WhenPresetId;
  customPattern: string;
  prompt: string;
  enabled: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  preset: "every_1h",
  customPattern: "",
  prompt: "",
  enabled: true,
};

export function AutomationPanel({
  agentId,
  onOpenSession,
  className,
}: {
  agentId: string | null;
  /** 打开某次自动化产生的 system 会话 */
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const { confirm } = useConfirmDialog();
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [heartbeat, setHeartbeat] = useState<AgentHeartbeat | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentSchedule | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) {
      setSchedules([]);
      setHeartbeat(null);
      setRuns([]);
      setLoading(false);
      return;
    }
    try {
      const [s, h, r] = await Promise.all([
        listSchedules(agentId),
        getHeartbeat(agentId),
        listAutomationRuns(agentId, { limit: 8 }),
      ]);
      setSchedules(s);
      setHeartbeat(h);
      setRuns(r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(s: AgentSchedule) {
    const { preset, custom } = whenPresetFromPattern(s.pattern);
    setEditing(s);
    setForm({
      name: s.name,
      preset,
      customPattern: custom || s.pattern,
      prompt: s.prompt,
      enabled: s.enabled,
    });
    setDialogOpen(true);
  }

  async function saveForm() {
    if (!agentId) return;
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    if (!name) {
      toast.error("给任务起个名字");
      return;
    }
    if (!prompt) {
      toast.error("写清楚要做的事");
      return;
    }
    const pattern = patternFromWhenPreset(form.preset, form.customPattern);
    if (!pattern) {
      toast.error("选择执行时间");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateSchedule(agentId, editing.id, {
          name,
          pattern,
          prompt,
          enabled: form.enabled,
        });
      } else {
        await createSchedule(agentId, {
          name,
          pattern,
          prompt,
          enabled: form.enabled,
        });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleSchedule(s: AgentSchedule, enabled: boolean) {
    if (!agentId) return;
    try {
      await updateSchedule(agentId, s.id, { enabled });
      setSchedules((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeSchedule(s: AgentSchedule) {
    if (!agentId) return;
    if (
      !(await confirm({
        title: `删除「${s.name}」？`,
        description: "之后不会再自动执行。",
        confirmLabel: "删除",
      }))
    ) {
      return;
    }
    try {
      await deleteSchedule(agentId, s.id);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSchedule(s: AgentSchedule) {
    if (!agentId) return;
    setBusyId(s.id);
    try {
      const run = await runScheduleNow(agentId, s.id);
      toast.success("已开始");
      await load();
      if (run.sessionId && onOpenSession) onOpenSession(run.sessionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function patchHeartbeat(patch: {
    enabled?: boolean;
    intervalMinutes?: number;
  }) {
    if (!agentId) return;
    setBusyId("heartbeat");
    try {
      const next = await saveHeartbeat(agentId, patch);
      setHeartbeat(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function runHb() {
    if (!agentId) return;
    setBusyId("heartbeat-run");
    try {
      const run = await runHeartbeatNow(agentId);
      toast.success("已触发检查");
      await load();
      if (run.sessionId && onOpenSession) onOpenSession(run.sessionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!agentId) {
    return (
      <div className={cn("px-3 py-6 text-sm text-muted-foreground", className)}>
        先选择 Agent
      </div>
    );
  }

  if (loading || !heartbeat) {
    return (
      <div className={cn("flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" />
        加载任务…
      </div>
    );
  }

  const intervalItems = HEARTBEAT_INTERVAL_OPTIONS.map((o) => ({
    value: String(o.value),
    label: o.label,
  }));
  const intervalValue = HEARTBEAT_INTERVAL_OPTIONS.some(
    (o) => o.value === heartbeat.intervalMinutes,
  )
    ? String(heartbeat.intervalMinutes)
    : "60";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-3 pt-1">
        {/* 周期检查：当作特殊的一条「常驻任务」写 */}
        <article className="group px-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium leading-snug">周期检查</h3>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {heartbeat.enabled
                  ? `按设定节奏自检工作区；下次 ${formatRelativeTime(heartbeat.nextRunAt)}`
                  : "关闭时不打扰。打开后 Agent 会定时自检。"}
              </p>
            </div>
            <Switch
              checked={heartbeat.enabled}
              disabled={busyId === "heartbeat"}
              onCheckedChange={(v) => void patchHeartbeat({ enabled: v })}
              aria-label="开启周期检查"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              value={intervalValue}
              onValueChange={(v) => {
                if (v == null) return;
                void patchHeartbeat({ intervalMinutes: Number(v) });
              }}
              items={intervalItems}
              disabled={busyId === "heartbeat"}
            >
              <SelectTrigger
                size="sm"
                className="h-7 max-w-[9.5rem] border-0 bg-muted/50 px-2 text-xs shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervalItems.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              disabled={busyId === "heartbeat-run"}
              onClick={() => void runHb()}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              {busyId === "heartbeat-run" ? "执行中…" : "现在检查一次"}
            </button>
          </div>
        </article>

        <div className="h-px bg-border/60" />

        {/* 定时任务：每条任务是一篇短内容，不是行列表 */}
        <section className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h3 className="text-xs font-medium text-muted-foreground">定时任务</h3>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3" />
              新建
            </button>
          </div>

          {schedules.length === 0 ? (
            <button
              type="button"
              onClick={openCreate}
              className="w-full rounded-lg px-2 py-4 text-left transition-colors hover:bg-muted/50"
            >
              <p className="text-sm font-medium">还没有定时任务</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                写一条「到点做什么」——日报、巡检、清理都行。点这里新建。
              </p>
            </button>
          ) : (
            <ul className="space-y-0.5">
              {schedules.map((s) => (
                <li key={s.id}>
                  <TaskBlock
                    schedule={s}
                    busy={busyId === s.id}
                    onOpen={() => openEdit(s)}
                    onToggle={(on) => void toggleSchedule(s, on)}
                    onRun={() => void runSchedule(s)}
                    onDelete={() => void removeSchedule(s)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 最近执行：一行一条内容，无表头 */}
        {runs.length > 0 ? (
          <>
            <div className="h-px bg-border/60" />
            <section className="space-y-1 px-1">
              <h3 className="text-xs font-medium text-muted-foreground">最近执行</h3>
              <ul className="space-y-2">
                {runs.map((r) => {
                  const title =
                    r.kind === "heartbeat"
                      ? "周期检查"
                      : schedules.find((s) => s.id === r.scheduleId)?.name ||
                        "定时任务";
                  const ok = r.status === "completed" || r.status === "ok";
                  const failed = r.status === "failed";
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        disabled={!r.sessionId}
                        onClick={() => {
                          if (r.sessionId && onOpenSession) onOpenSession(r.sessionId);
                        }}
                        className={cn(
                          "w-full text-left",
                          r.sessionId && "hover:opacity-80",
                          !r.sessionId && "cursor-default",
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm">{title}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatRelativeTime(r.createdAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          {failed
                            ? r.error || "失败"
                            : ok
                              ? "完成"
                              : r.status === "running"
                                ? "进行中"
                                : r.status}
                          {r.sessionId ? " · 查看记录" : ""}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        ) : null}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading text-base">
              {editing ? "编辑任务" : "新建任务"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="at-name">名称</Label>
              <Input
                id="at-name"
                placeholder="例如：每日站会纪要"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>何时</Label>
              <div className="flex flex-wrap gap-1">
                {WHEN_PRESETS.filter((p) => p.id !== "custom").map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, preset: p.id }))}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs transition-colors",
                      form.preset === p.id
                        ? "bg-foreground text-background"
                        : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, preset: "custom" }))}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs transition-colors",
                    form.preset === "custom"
                      ? "bg-foreground text-background"
                      : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  自定义
                </button>
              </div>
              {form.preset === "custom" ? (
                <Input
                  placeholder="@every_45m 或 0 9 * * 1-5"
                  value={form.customPattern}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customPattern: e.target.value }))
                  }
                />
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {describePattern(
                    patternFromWhenPreset(form.preset, form.customPattern),
                  )}
                  {form.preset.includes("daily") || form.preset.includes("week")
                    ? " · 按本机时区"
                    : ""}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="at-prompt">做什么</Label>
              <Textarea
                id="at-prompt"
                rows={4}
                placeholder="用自然语言写目标和产物。"
                value={form.prompt}
                onChange={(e) =>
                  setForm((f) => ({ ...f, prompt: e.target.value }))
                }
              />
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {PROMPT_EXAMPLES.map((ex) => (
                  <button
                    key={ex.title}
                    type="button"
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setForm((f) => ({ ...f, prompt: ex.text }))}
                  >
                    {ex.title}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">创建后启用</span>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={() => void saveForm()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editing ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 单条任务：标题 + 指令摘要作正文 + 时间元信息 */
function TaskBlock({
  schedule: s,
  busy,
  onOpen,
  onToggle,
  onRun,
  onDelete,
}: {
  schedule: AgentSchedule;
  busy: boolean;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className={cn(
        "group relative rounded-lg px-2 py-2.5 transition-colors",
        "hover:bg-muted/50",
        !s.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <h4 className="truncate text-sm font-medium leading-snug">{s.name}</h4>
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
            {s.prompt}
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">
            {describePattern(s.pattern)}
            {s.enabled && s.nextRunAt
              ? ` · ${formatRelativeTime(s.nextRunAt)}`
              : s.enabled
                ? ""
                : " · 已暂停"}
            {s.lastStatus === "failed"
              ? " · 上次失败"
              : s.runCount > 0
                ? ` · 已跑 ${s.runCount} 次`
                : ""}
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100">
          <button
            type="button"
            title="立即运行"
            disabled={busy}
            onClick={onRun}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="更多"
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                />
              }
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-28">
              <DropdownMenuItem onClick={onOpen}>编辑</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToggle(!s.enabled)}>
                {s.enabled ? "暂停" : "启用"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}
