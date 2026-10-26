"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SkillStorePanel } from "@/components/skills/skill-store-panel";
import { deleteSkill, listSkills, registerSpaceSkill, setSkillItemAutoUpdate, updateSkill, type SkillRecord } from "@/lib/skills";

export default function SpaceSkillsPage() {
  const { id } = useParams<{ id: string }>();
  const { confirm } = useConfirmDialog();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const load = useCallback(async () => {
    try { setSkills(await listSkills(id)); }
    catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try { await action(); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }
  async function remove(skill: SkillRecord) {
    if (!await confirm({ title: `从 Space 移除 ${skill.name}？`, description: "删除技能文件和所有 Agent 的启用引用。", confirmLabel: "移除", destructive: true })) return;
    await act(skill.id, () => deleteSkill(skill.id, id));
  }
  return <div className="space-y-8">
    <section className="space-y-4">
      <div><h1 className="text-xl font-semibold">技能</h1><p className="mt-1 text-sm text-muted-foreground">文件保存在 Space 服务器。Agent 只选择启用哪些技能，共享同一版本。</p></div>
      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : !skills.length ? <p className="text-sm text-muted-foreground">尚未安装技能。可以从下方商店安装，无需创建 Agent。</p> :
        <div className="divide-y divide-border">{skills.map(skill => <div key={skill.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{skill.title || skill.name}</p><p className="text-xs text-muted-foreground">{skill.description}</p>{skill.status === "conflict" ? <p className="mt-1 text-xs text-destructive">{skill.error}。请先移除冲突安装，再选择来源。</p> : null}<p className="mt-1 text-xs text-muted-foreground">{skill.version?.slice(0, 12) ?? "本地版本"}，{skill.agentIds.length} 个 Agent 启用</p></div>
          {!skill.builtin && skill.repoKey ? <label className="flex items-center gap-2 text-xs text-muted-foreground">自动更新<Switch checked={skill.autoUpdate ?? false} disabled={busy !== null || skill.status === "conflict"} onCheckedChange={enabled => void act(skill.id, () => setSkillItemAutoUpdate(skill.id, enabled, id))} /></label> : null}
          {skill.updateAvailable ? <Button size="xs" variant="outline" disabled={busy !== null || skill.status === "conflict"} onClick={() => void act(skill.id, () => updateSkill(skill.id, id))}>更新</Button> : null}
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void remove(skill)}>移除</Button>
        </div>)}</div>}
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void act("register", async () => { await registerSpaceSkill(id, workspacePath); setWorkspacePath(""); }); }}>
        <Input className="min-w-0 flex-1" aria-label="工作区技能目录" value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} placeholder="/skills/my-skill" />
        <Button variant="outline" disabled={!workspacePath.trim() || busy !== null}>登记工作区目录</Button>
      </form>
    </section>
    <section className="space-y-4"><h2 className="text-base font-medium">安装技能</h2><SkillStorePanel agents={[]} spaceId={id} onInstalled={() => void load()} /></section>
  </div>;
}
