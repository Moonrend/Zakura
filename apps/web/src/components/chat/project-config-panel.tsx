"use client";

/**
 * 项目配置：AGENTS.md / 项目技能 / hooks。文件系统为真相源。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  AGENT_HOOK_EVENTS,
  type AgentHookAction,
  type AgentHookEvent,
  type AgentHookMatcherGroup,
  type AgentHooksByEvent,
} from "@zakura/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  createProjectSkill,
  deleteProjectSkill,
  getProjectConfig,
  readProjectSkillFile,
  saveProjectHooks,
  saveProjectInstructions,
  saveProjectSkillFile,
  type ProjectConfigSnapshot,
} from "@/lib/agent-fs";
import { SkillMarkdown } from "@/components/skills/skill-markdown";
import { parseSkillBody } from "@/lib/skills";
import { cn } from "@/lib/utils";

export function ProjectConfigPanel({
  agentId,
  slug,
  className,
}: {
  agentId: string;
  slug: string;
  className?: string;
}) {
  const { confirm } = useConfirmDialog();
  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("instructions");
  const [instructions, setInstructions] = useState("");
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [hooks, setHooks] = useState<AgentHooksByEvent>({});
  const [savingHooks, setSavingHooks] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState("");
  const [savingSkill, setSavingSkill] = useState(false);
  const [previewSkill, setPreviewSkill] = useState<{ name: string; body: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getProjectConfig(agentId, slug);
      setConfig(res.config);
      setInstructions(res.config.instructions.content);
      setHooks(res.config.hooks.events);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveInstructions() {
    setSavingInstructions(true);
    try {
      const res = await saveProjectInstructions(agentId, slug, {
        content: instructions,
        file: "AGENTS.md",
      });
      setConfig(res.config);
      toast.success("已保存 AGENTS.md");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingInstructions(false);
    }
  }

  async function saveHooks() {
    setSavingHooks(true);
    try {
      const res = await saveProjectHooks(agentId, slug, {
        events: hooks,
        file: config?.hooks.file,
      });
      setConfig(res.config);
      setHooks(res.config.hooks.events);
      toast.success("已保存 hooks");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHooks(false);
    }
  }

  async function addSkill() {
    const name = newSkillName.trim();
    if (!name) {
      toast.error("请填写技能名");
      return;
    }
    setCreatingSkill(true);
    try {
      const res = await createProjectSkill(agentId, slug, {
        name,
        description: newSkillDesc.trim() || `${name} 项目技能`,
      });
      setConfig(res.config);
      setNewSkillName("");
      setNewSkillDesc("");
      toast.success(`已创建 ${res.skill.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSkill(false);
    }
  }

  async function openSkill(name: string) {
    try {
      const file = await readProjectSkillFile(agentId, slug, name);
      setEditingSkill(name);
      setSkillContent(file.content);
      setPreviewSkill({ name, body: parseSkillBody(file.content) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSkill() {
    if (!editingSkill) return;
    setSavingSkill(true);
    try {
      const res = await saveProjectSkillFile(agentId, slug, editingSkill, skillContent);
      setConfig(res.config);
      setPreviewSkill({ name: editingSkill, body: parseSkillBody(skillContent) });
      toast.success("已保存技能");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSkill(false);
    }
  }

  async function removeSkill(name: string) {
    if (!(await confirm({ title: `删除技能 ${name}？`, description: "将删除项目内该技能目录。", confirmLabel: "删除" }))) {
      return;
    }
    try {
      const res = await deleteProjectSkill(agentId, slug, name);
      setConfig(res.config);
      if (editingSkill === name) {
        setEditingSkill(null);
        setSkillContent("");
        setPreviewSkill(null);
      }
      toast.success(`已删除 ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div className={cn("flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" />
        加载项目配置…
      </div>
    );
  }

  if (!config?.exists) {
    return (
      <div className={cn("px-1 py-8 text-sm text-muted-foreground", className)}>
        项目目录不存在。电脑环境未开启或目录已被删除。
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="instructions">指令</TabsTrigger>
          <TabsTrigger value="skills">技能 {config.skills.length ? `(${config.skills.length})` : ""}</TabsTrigger>
          <TabsTrigger value="hooks">Hooks</TabsTrigger>
        </TabsList>

        <TabsContent value="instructions" className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {config.instructions.claudeFallback
              ? "目前只有 CLAUDE.md，保存后会写成优先使用的 AGENTS.md。"
              : config.instructions.file
                ? `正在编辑 ${config.instructions.file}。绑定本项目的会话会自动注入。`
                : "还没有指令文件。保存后写入项目根目录 AGENTS.md。"}
          </p>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-48 font-mono text-xs"
            placeholder="# 项目说明&#10;写给 Agent 的约定、构建方式、不要动的目录…"
          />
          <Button size="sm" onClick={() => void saveInstructions()} disabled={savingInstructions}>
            {savingInstructions ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存 AGENTS.md
          </Button>
        </TabsContent>

        <TabsContent value="skills" className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            项目技能在 <code>.agents/skills/</code> 或 <code>.claude/skills/</code>，只对绑定本项目的会话可见。
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="技能名，如 deploy"
              className="sm:max-w-40"
            />
            <Input
              value={newSkillDesc}
              onChange={(e) => setNewSkillDesc(e.target.value)}
              placeholder="一句话描述（写入 SKILL.md）"
              className="flex-1"
            />
            <Button size="sm" onClick={() => void addSkill()} disabled={creatingSkill}>
              {creatingSkill ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              新建
            </Button>
          </div>
          {config.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">这个项目还没有技能</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {config.skills.map((s) => (
                <li key={s.path} className="flex items-start gap-2 bg-card px-3 py-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void openSkill(s.name)}
                  >
                    <div className="text-sm font-medium">{s.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{s.description || s.path}</div>
                  </button>
                  <Button size="icon-sm" variant="ghost" onClick={() => void removeSkill(s.name)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {editingSkill ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm">{editingSkill} / SKILL.md</Label>
                <Button size="sm" onClick={() => void saveSkill()} disabled={savingSkill}>
                  {savingSkill ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  保存
                </Button>
              </div>
              <Textarea
                value={skillContent}
                onChange={(e) => {
                  setSkillContent(e.target.value);
                  setPreviewSkill({ name: editingSkill, body: parseSkillBody(e.target.value) });
                }}
                className="min-h-40 font-mono text-xs"
              />
              {previewSkill ? (
                <div className="max-h-48 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2">
                  <SkillMarkdown content={previewSkill.body} />
                </div>
              ) : null}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="hooks" className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {config.hooks.file
              ? `当前写入 ${config.hooks.file}${config.hooks.sources.length > 1 ? `（另外还从 ${config.hooks.sources.slice(1).map((s) => s.file).join("、")} 加载）` : ""}。`
              : "保存后写入 .agents/hooks.json。command 型需要开启电脑；prompt 型会注入上下文。"}
          </p>
          <HooksEditor events={hooks} onChange={setHooks} />
          <Button size="sm" onClick={() => void saveHooks()} disabled={savingHooks}>
            {savingHooks ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存 Hooks
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HooksEditor({
  events,
  onChange,
}: {
  events: AgentHooksByEvent;
  onChange: (next: AgentHooksByEvent) => void;
}) {
  function setEvent(event: AgentHookEvent, groups: AgentHookMatcherGroup[]) {
    const next = { ...events };
    if (!groups.length) delete next[event];
    else next[event] = groups;
    onChange(next);
  }

  function addGroup(event: AgentHookEvent) {
    const groups = [...(events[event] ?? [])];
    groups.push({ hooks: [{ type: "prompt", prompt: "" }] });
    setEvent(event, groups);
  }

  return (
    <div className="space-y-3">
      {AGENT_HOOK_EVENTS.map((event) => {
        const groups = events[event] ?? [];
        return (
          <div key={event} className="rounded-lg border border-border p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium">{event}</div>
              <Button size="sm" variant="ghost" onClick={() => addGroup(event)}>
                <Plus className="size-3.5" />
                添加
              </Button>
            </div>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground">未配置</p>
            ) : (
              <div className="space-y-2">
                {groups.map((group, gi) => (
                  <HookGroupEditor
                    key={`${event}-${gi}`}
                    group={group}
                    onChange={(g) => {
                      const next = groups.slice();
                      next[gi] = g;
                      setEvent(event, next);
                    }}
                    onRemove={() => setEvent(event, groups.filter((_, i) => i !== gi))}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HookGroupEditor({
  group,
  onChange,
  onRemove,
}: {
  group: AgentHookMatcherGroup;
  onChange: (g: AgentHookMatcherGroup) => void;
  onRemove: () => void;
}) {
  function setAction(i: number, action: AgentHookAction) {
    const hooks = group.hooks.slice();
    hooks[i] = action;
    onChange({ ...group, hooks });
  }

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={group.matcher ?? ""}
          onChange={(e) => onChange({ ...group, matcher: e.target.value || undefined })}
          placeholder="matcher（工具名正则，可空）"
          className="h-8 text-xs"
        />
        <Button size="icon-sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {group.hooks.map((action, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              value={action.type}
              onChange={(e) =>
                setAction(i, {
                  ...action,
                  type: e.target.value === "command" ? "command" : "prompt",
                })
              }
            >
              <option value="prompt">prompt</option>
              <option value="command">command</option>
            </select>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() =>
                onChange({ ...group, hooks: group.hooks.filter((_, j) => j !== i) })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          {action.type === "command" ? (
            <Input
              value={action.command ?? ""}
              onChange={(e) => setAction(i, { ...action, command: e.target.value })}
              placeholder="shell 命令，cwd 为项目目录"
              className="font-mono text-xs"
            />
          ) : (
            <Textarea
              value={action.prompt ?? ""}
              onChange={(e) => setAction(i, { ...action, prompt: e.target.value })}
              placeholder="注入到上下文的提示"
              className="min-h-16 text-xs"
            />
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange({ ...group, hooks: [...group.hooks, { type: "prompt", prompt: "" }] })}
      >
        <Plus className="size-3.5" />
        动作
      </Button>
    </div>
  );
}
