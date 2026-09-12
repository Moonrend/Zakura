"use client";

/**
 * 对话侧栏 · 定时任务列表。
 * 新建走 Agent 对话创建；本面板只负责查看与管理。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  type AgentSchedule,
  type WhenPresetId,
  WHEN_PRESETS,
  deleteSchedule,
  describePattern,
  formatRelativeTime,
  formatAbsoluteTime,
  listSchedules,
  patternFromWhenPreset,
  runScheduleNow,
  statusLabel,
  updateSchedule,
  whenPresetFromPattern,
} from "@/lib/automation";

type EditForm = {
  name: string;
  preset: WhenPresetId;
  customPattern: string;
  prompt: string;
  enabled: boolean;
  project: string;
};

export function AutomationPanel({
  agentId,
  projects = [],
  onAskAgentCreate,
  onOpenSession,
  className,
  layout = "rail",
}: {
  agentId: string | null;
  projects?: string[];
  /** 用自然语言描述，交给 Agent 创建定时任务 */
  onAskAgentCreate: (goal: string) => void;
  onOpenSession?: (sessionId: string) => void;
  className?: string;
  /** rail=侧栏列表；page=主区完整表 */
  layout?: "rail" | "page";
}) {
  const { confirm } = useConfirmDialog();
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createGoal, setCreateGoal] = useState("");
  const [createProject, setCreateProject] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<AgentSchedule | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) {
      setSchedules([]);
      setLoading(false);
      return;
    }
    try {
      setSchedules(await listSchedules(agentId));
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

  const groupedSchedules = useMemo(() => {
    const by = new Map<string, AgentSchedule[]>();
    const unbound: AgentSchedule[] = [];
    for (const s of schedules) {
      if (s.project) {
        const list = by.get(s.project) ?? [];
        list.push(s);
        by.set(s.project, list);
      } else {
        unbound.push(s);
      }
    }
    const named = [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { named, unbound };
  }, [schedules]);

  function openCreate() {
    setCreateGoal("");
    setCreateProject(projects[0] ?? "");
    setCreateOpen(true);
  }

  function submitCreate() {
    const goal = createGoal.trim();
    if (!goal) {
      toast.error("说一下要定时做什么");
      return;
    }
    const bits = [goal];
    if (createProject.trim()) {
      bits.push(`请把 create_schedule 的 project 设为 ${createProject.trim()}。`);
    }
    setCreateOpen(false);
    onAskAgentCreate(bits.join("\n"));
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
      project: s.project ?? "",
    });
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!agentId || !editing || !form) return;
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    if (!name || !prompt) {
      toast.error("名称和内容不能为空");
      return;
    }
    const pattern = patternFromWhenPreset(form.preset, form.customPattern);
    if (!pattern) {
      toast.error("请选择执行时间");
      return;
    }
    setSaving(true);
    try {
      await updateSchedule(agentId, editing.id, {
        name,
        pattern,
        prompt,
        enabled: form.enabled,
        project: form.project.trim() || null,
      });
      setEditOpen(false);
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
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
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

  if (!agentId) {
    return (
      <div className={cn("px-3 py-6 text-sm text-muted-foreground", className)}>
        先选择 Agent
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="size-3.5 animate-spin" />
        加载中…
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {layout === "page" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4 md:px-8">
          <div className="mb-6 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium tracking-tight">定时任务</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                到点自动跑，结果会出现在对话里。
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={openCreate}>
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
          {schedules.length === 0 ? (
            <button
              type="button"
              onClick={openCreate}
              className="w-full max-w-lg rounded-xl border border-dashed border-border/60 px-4 py-10 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              还没有定时任务。描述想定期做的事，交给 Agent 创建。
            </button>
          ) : (
            <div className="flex flex-col">
              <div className="mb-1 hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_5.5rem_auto] gap-3 px-2 text-[11px] text-muted-foreground md:grid">
                <span>名称</span>
                <span>何时</span>
                <span>下次</span>
                <span>上次</span>
                <span />
              </div>
              {groupedSchedules.named.map(([name, items]) => (
                <div key={name} className="mb-4">
                  <div className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground/70">{name}</div>
                  <ul>
                    {items.map((s) => (
                      <li key={s.id}>
                        <TaskPageRow
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
                </div>
              ))}
              {groupedSchedules.unbound.length > 0 ? (
                <div>
                  <div className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground/70">其他任务</div>
                  <ul>
                    {groupedSchedules.unbound.map((s) => (
                      <li key={s.id}>
                        <TaskPageRow
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
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        <div className="mb-1 flex items-center justify-between gap-2 px-1">
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
            className="w-full rounded-lg px-2 py-4 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            暂无定时任务，点此让 Agent 创建
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            {groupedSchedules.named.map(([name, items]) => (
              <div key={name}>
                <div className="px-1 pb-0.5 text-[11px] text-muted-foreground/60">{name}</div>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <TaskRow
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
              </div>
            ))}
            {groupedSchedules.unbound.length > 0 ? (
              <div>
                <div className="px-1 pb-0.5 text-[11px] text-muted-foreground/60">其他任务</div>
                <ul>
                  {groupedSchedules.unbound.map((s) => (
                    <li key={s.id}>
                      <TaskRow
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
              </div>
            ) : null}
          </div>
        )}
      </div>
      )}

      {/* 新建：自然语言 → Agent */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">新建定时任务</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="at-goal">想让 Agent 定时做什么？</Label>
            <Textarea
              id="at-goal"
              rows={4}
              autoFocus
              placeholder="例如：每个工作日早上 9 点检查工作区并写一份简短日报"
              value={createGoal}
              onChange={(e) => setCreateGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitCreate();
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Agent 会自行决定名称、周期和指令。⌘/Ctrl + Enter 发送
            </p>
            {projects.length > 0 ? (
              <div className="space-y-1.5">
                <Label>项目</Label>
                <Select
                  value={createProject || "__none__"}
                  onValueChange={(v) => {
                    if (v == null || v === "__none__") setCreateProject("");
                    else setCreateProject(v);
                  }}
                  items={[
                    { value: "__none__", label: "不绑定" },
                    ...projects.map((p) => ({ value: p, label: p })),
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不绑定</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={submitCreate} disabled={!createGoal.trim()}>
              让 Agent 创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑已有任务 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">编辑任务</DialogTitle>
          </DialogHeader>
          {form ? (
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <Label htmlFor="at-name">名称</Label>
                <Input
                  id="at-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>何时</Label>
                <Select
                  value={form.preset}
                  onValueChange={(v) => {
                    if (v == null) return;
                    setForm((f) => (f ? { ...f, preset: v as WhenPresetId } : f));
                  }}
                  items={WHEN_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WHEN_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.preset === "custom" ? (
                  <Input
                    placeholder="@every_45m 或 0 9 * * 1-5"
                    value={form.customPattern}
                    onChange={(e) =>
                      setForm((f) => (f ? { ...f, customPattern: e.target.value } : f))
                    }
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {describePattern(patternFromWhenPreset(form.preset, form.customPattern))}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="at-prompt">做什么</Label>
                <Textarea
                  id="at-prompt"
                  rows={4}
                  value={form.prompt}
                  onChange={(e) =>
                    setForm((f) => (f ? { ...f, prompt: e.target.value } : f))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>项目</Label>
                <Select
                  value={form.project || "__none__"}
                  onValueChange={(v) => {
                    if (v == null || v === "__none__") {
                      setForm((f) => (f ? { ...f, project: "" } : f));
                    } else {
                      setForm((f) => (f ? { ...f, project: v } : f));
                    }
                  }}
                  items={[
                    { value: "__none__", label: "不绑定" },
                    ...projects.map((p) => ({ value: p, label: p })),
                    ...(form.project && !projects.includes(form.project)
                      ? [{ value: form.project, label: `${form.project}（目录已删）` }]
                      : []),
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不绑定</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                    {form.project && !projects.includes(form.project) ? (
                      <SelectItem value={form.project}>{form.project}（目录已删）</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">启用</span>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) =>
                    setForm((f) => (f ? { ...f, enabled: v } : f))
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void saveEdit()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskRow({
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
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg px-1 py-1.5",
        "hover:bg-muted/50",
        !s.enabled && "opacity-55",
      )}
    >
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm">{s.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {describePattern(s.pattern)}
          {s.enabled && s.nextRunAt ? ` · ${formatRelativeTime(s.nextRunAt)}` : null}
          {!s.enabled ? " · 已暂停" : null}
        </div>
      </button>

      <div className="flex shrink-0 items-center opacity-100 md:opacity-0 md:group-hover:opacity-100">
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
  );
}

function TaskPageRow({
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
    <div
      className={cn(
        "group grid grid-cols-1 items-center gap-1 rounded-lg px-2 py-2.5 transition-colors duration-150 ease-fluid hover:bg-muted/35",
        "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_5.5rem_auto] md:gap-3",
        !s.enabled && "opacity-55",
      )}
    >
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <div className="truncate text-sm">{s.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground md:hidden">
          {describePattern(s.pattern)}
          {s.enabled && s.nextRunAt ? ` · ${formatRelativeTime(s.nextRunAt)}` : null}
        </div>
      </button>
      <div className="hidden truncate text-sm text-muted-foreground md:block">
        {describePattern(s.pattern)}
      </div>
      <div className="hidden text-sm text-muted-foreground md:block">
        {s.enabled ? formatRelativeTime(s.nextRunAt) : "已暂停"}
      </div>
      <div
        className="hidden text-sm text-muted-foreground md:block"
        title={formatAbsoluteTime(s.lastRunAt)}
      >
        {statusLabel(s.lastStatus)}
      </div>
      <div className="flex shrink-0 items-center justify-end">
        <button
          type="button"
          title="立即运行"
          disabled={busy}
          onClick={onRun}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
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
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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
  );
}
