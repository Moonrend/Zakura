"use client";

import { useCallback, useEffect, useState } from "react";
import type { SpaceToolApprovalConfig } from "@zakura/shared";
import { useSpaceSettings } from "@/components/space-settings-layout";
import { SettingsHeader, SettingsRow, SettingsSaveIndicator, SettingsSection } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageLoading } from "@/components/ui/progress-linear";
import { useAutoSave } from "@/hooks/use-auto-save";
import { fetchSpaceApprovals, saveSpaceApprovals } from "@/lib/spaces";

const SCOPES = [{ value: "risky", label: "有风险或未知的调用" }, { value: "all", label: "全部调用" }];

export default function SpaceApprovalsPage() {
  const { spaceId } = useSpaceSettings();
  const [config, setConfig] = useState<SpaceToolApprovalConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const persist = useCallback(async (patch: Partial<SpaceToolApprovalConfig>) => {
    await saveSpaceApprovals(spaceId, patch);
  }, [spaceId]);
  const { status, error, saveNow } = useAutoSave(persist);
  useEffect(() => {
    let alive = true;
    setConfig(null);
    setLoadError("");
    void fetchSpaceApprovals(spaceId).then(value => { if (alive) setConfig(value); })
      .catch(err => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [spaceId, reload]);
  if (!config) return loadError ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重试</Button></div> : <PageLoading />;
  const update = (patch: Partial<SpaceToolApprovalConfig>) => {
    setConfig(current => current ? { ...current, ...patch } : current);
    saveNow(patch);
  };
  return <div className="space-y-5">
    <SettingsHeader title="工具审批" description="本空间共用的 AI 审批范围与工具规则。各 Agent 的审批策略和模型在 Agent 设置中选择。" actions={<SettingsSaveIndicator status={status} error={error} />} />
    <SettingsSection title="AI 审批范围" description="Jev 通过后自动执行；无法确定或建议拒绝时，按 Agent 的配置转人工确认。">
      <SettingsRow label="默认审查">
        <Select value={config.scope} items={SCOPES} onValueChange={value => { if (value === "risky" || value === "all") update({ scope: value }); }}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>{SCOPES.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="自动允许已知只读工具" description="包括读取文件、列目录、查询会话、网络搜索和网页读取。执行命令与未知 MCP 工具仍需审查。">
        <Switch aria-label="自动允许已知只读工具" checked={config.autoAllowReadOnly !== false} onCheckedChange={value => update({ autoAllowReadOnly: value })} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="工具范围" description="用于“有风险或未知的调用”范围。每行一个工具名或匹配规则，支持 * 通配符。需要审查的规则优先于自动允许。">
      <MatcherEditor key={`${spaceId}-dangerous`} label="需要审查的工具" description="将默认只读工具或特定调用纳入 AI 审查；未知工具原本就会审查。" value={config.dangerousTools ?? []} placeholder={'fs_read\nBash(git push*)\nmcp__github__*'} onSave={dangerousTools => update({ dangerousTools })} />
      <MatcherEditor key={`${spaceId}-safe`} label="自动允许的工具" description="添加你信任的低风险工具。显式拒绝、显式人工审批和“始终审批”仍然优先。" value={config.safeTools ?? []} placeholder={'mcp__docs__search\nmcp__docs__get_page'} onSave={safeTools => update({ safeTools })} />
    </SettingsSection>
  </div>;
}

function MatcherEditor({ label, description, value, placeholder, onSave }: {
  label: string; description: string; value: string[]; placeholder: string; onSave: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const [editing, setEditing] = useState(false);
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{label}</span>{!editing ? <Button size="sm" variant="ghost" onClick={() => { setDraft(value.join("\n")); setEditing(true); }}>编辑</Button> : null}</div>
    {editing ? <>
      <Textarea aria-label={label} value={draft} rows={3} placeholder={placeholder} className="font-mono text-xs" onChange={event => setDraft(event.target.value)} />
      <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button><Button size="sm" variant="outline" onClick={() => {
        const next = [...new Set(draft.split("\n").map(line => line.trim()).filter(Boolean))];
        onSave(next);
        setEditing(false);
      }}>保存规则</Button></div>
    </> : value.length ? <ul className="space-y-1 text-xs">{value.map(matcher => <li key={matcher} className="break-all font-mono">{matcher}</li>)}</ul> : <p className="text-xs text-muted-foreground">未添加自定义规则</p>}
    <p className="text-xs text-muted-foreground">{description}</p>
  </div>;
}
