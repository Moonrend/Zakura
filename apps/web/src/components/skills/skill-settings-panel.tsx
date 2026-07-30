"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Database,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCw,
  Trash2,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  checkSkillUpdates,
  deleteSkillToken,
  fetchSkillAutoUpdate,
  fetchSkillCacheStatus,
  formatBytes,
  formatRelative,
  listSkillTokens,
  saveSkillToken,
  setSkillAutoUpdate,
  syncSkillRepo,
  type SkillAutoUpdateStatus,
  type SkillCacheStatus,
  type SkillTokenInfo,
  type SkillTokenScope,
} from "@/lib/skills";

const SCOPE_LABEL: Record<SkillTokenScope, string> = {
  platform: "整站默认",
  tenant: "本团队",
};

function TokenRow({
  info,
  onRemoved,
}: {
  info: SkillTokenInfo;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const envManaged = info.label === "GITHUB_TOKEN 环境变量";
  const readOnly = info.scope === "platform";

  async function remove() {
    setBusy(true);
    try {
      await deleteSkillToken(info.provider, info.scope);
      toast.success("令牌已删除");
      onRemoved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      {info.scope === "platform" ? (
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <User className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{SCOPE_LABEL[info.scope]}</span>
          <Badge variant="outline" className="text-[10px]">
            {info.provider}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">••••{info.hint}</span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {info.label ?? "未命名"}
          {info.lastUsedAt ? ` · 最近使用 ${formatRelative(info.lastUsedAt)}` : " · 尚未使用"}
        </p>
      </div>
      {readOnly ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {envManaged ? "由环境变量提供" : "在系统配置里管理"}
        </span>
      ) : (
        <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      )}
    </div>
  );
}

function AutoUpdateSection({
  status,
  onChanged,
}: {
  status: SkillAutoUpdateStatus | null;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      await setSkillAutoUpdate(enabled);
      toast.success(enabled ? "已开启自动更新" : "已关闭自动更新");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      const { result } = await checkSkillUpdates();
      const parts: string[] = [];
      if (result.updated.length) parts.push(`更新 ${result.updated.join("、")}`);
      if (result.builtinSynced) parts.push(`内置技能同步 ${result.builtinSynced} 次`);
      if (result.failed.length) parts.push(`${result.failed.length} 个失败`);
      toast.success(parts.length ? parts.join("；") : "所有技能都已是最新版本");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <RotateCw className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">自动更新</h3>
        {status?.pendingCount ? (
          <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
            {status.pendingCount} 个待更新
          </Badge>
        ) : null}
      </div>
      <div className="space-y-2.5 rounded-xl border border-border bg-card p-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">自动更新第三方技能</p>
            <p className="text-[11px] text-muted-foreground">
              {status?.lastRunAt
                ? `上次运行 ${formatRelative(status.lastRunAt)}`
                : "尚未运行过"}
              {status?.lastResult
                ? ` · 更新 ${status.lastResult.updated.length} 个，${status.lastResult.upToDate} 个已最新`
                : ""}
            </p>
          </div>
          <Switch
            checked={status?.enabled ?? true}
            disabled={saving || !status}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>

        {status?.lastResult?.failed.length ? (
          <p className="truncate text-[11px] text-destructive">
            上次失败：
            {status.lastResult.failed.map((f) => `${f.name}（${f.error}）`).join("，")}
          </p>
        ) : null}

        <Button
          size="sm"
          variant="outline"
          disabled={checking}
          onClick={() => void checkNow()}
        >
          {checking ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          立即检查更新
        </Button>
      </div>
    </section>
  );
}

export function SkillSettingsPanel() {
  const [tokens, setTokens] = useState<SkillTokenInfo[]>([]);
  const [cache, setCache] = useState<SkillCacheStatus | null>(null);
  const [autoUpdate, setAutoUpdate] = useState<SkillAutoUpdateStatus | null>(null);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, c, a] = await Promise.all([
        listSkillTokens(),
        fetchSkillCacheStatus(),
        fetchSkillAutoUpdate(),
      ]);
      setTokens(t.tokens);
      setCache(c);
      setAutoUpdate(a);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await saveSkillToken({
        provider: "github",
        token: token.trim(),
        scope: "tenant",
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      toast.success("令牌已保存");
      setToken("");
      setLabel("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function sync(slug: string) {
    setSyncing(slug);
    try {
      await syncSkillRepo(slug);
      toast.success(`${slug} 已同步`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="space-y-6">
      <AutoUpdateSection status={autoUpdate} onChanged={load} />

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">本团队来源令牌</h3>
        </div>

        {tokens.length ? (
          <div className="space-y-1.5">
            {tokens.map((info) => (
              <TokenRow key={`${info.scope}:${info.provider}`} info={info} onRemoved={load} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            尚未配置任何令牌
          </p>
        )}

        <div className="space-y-2.5 rounded-xl border border-border bg-card p-3.5">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">GitHub Token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… 或 github_pat_…（读私有仓库需 repo 权限）"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">备注</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="可选"
                className="text-xs sm:w-40"
              />
            </div>
            <Button
              className="sm:self-end"
              disabled={!token.trim() || saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Database className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">平台缓存</h3>
          {cache ? (
            <span className="text-xs text-muted-foreground">
              {cache.repos.length} 个仓库 · {cache.totalSkills} 个技能 ·{" "}
              {formatBytes(cache.totalBytes)}
            </span>
          ) : null}
        </div>

        {cache?.repos.length ? (
          <div className="overflow-hidden rounded-xl border border-border">
            {cache.repos.map((repo, i) => (
              <div
                key={repo.repoKey}
                className={cn(
                  "flex items-center gap-3 bg-card px-3 py-2.5 sm:px-3.5",
                  i > 0 && "border-t border-border",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-mono text-xs">{repo.slug}</span>
                    {repo.partial ? (
                      <Badge variant="outline" className="text-[10px]">
                        仅清单
                      </Badge>
                    ) : null}
                    {repo.pending ? (
                      <Badge variant="outline" className="text-[10px]">
                        待同步
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {repo.skillCount} 个技能 · {formatBytes(repo.sizeBytes)}
                    {repo.version ? ` · ${repo.version.slice(0, 8)}` : ""}
                    {repo.checkedAt ? ` · ${formatRelative(repo.checkedAt)}检查` : ""}
                  </p>
                  {repo.lastError ? (
                    <p className="truncate text-[11px] text-destructive">{repo.lastError}</p>
                  ) : null}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="立即同步"
                  disabled={syncing === repo.slug}
                  onClick={() => void sync(repo.slug)}
                >
                  {syncing === repo.slug ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            还没有缓存任何仓库
          </p>
        )}
      </section>
    </div>
  );
}
