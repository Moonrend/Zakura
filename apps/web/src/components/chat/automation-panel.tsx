"use client";

/**
 * 对话侧栏 · 定时任务列表。
 * 新建走 Agent 对话创建；本面板只负责查看与管理。
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
  type AgentSchedule,
  type WhenPresetId,
  WHEN_PRESETS,
  deleteSchedule,
  describePattern,
  formatRelativeTime,
  listSchedules,
  patternFromWhenPreset,
  runScheduleNow,
  updateSchedule,
  whenPresetFromPattern,
} from "@/lib/automation";

type EditForm = {
  name: string;
  preset: WhenPresetId;
  customPattern: string;
  prompt: string;
  enabled: boolean;
};

export function AutomationPanel({
  agentId,
  onAskAgentCreate,
  onOpenSession,
  className,
}: {
  agentId: string | null;
  /** 用自然语言描述，交给 Agent 创建定时任务 */
  onAskAgentCreate: (goal: string) => void;
  onOpenSession?: (sessionId: string) => void;
  className?: string;
}) {
  const { confirm } = useConfirmDialog();
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createGoal, setCreateGoal] = useState("");

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

  function openCreate() {
    setCreateGoal("");
    setCreateOpen(true);
  }

  function submitCreate() {
    const goal = createGoal.trim();
    if (!goal) {
      toast.error("说一下要定时做什么");
      return;
    }
    setCreateOpen(false);
    onAskAgentCreate(goal);
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
          <ul>
            {schedules.map((s) => (
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
        )}
      </div>

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
