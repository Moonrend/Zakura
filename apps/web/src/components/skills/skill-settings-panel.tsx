"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Check,
  Database,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  deleteSkillToken,
  fetchSkillCacheStatus,
  formatBytes,
  listSkillTokens,
  saveSkillToken,
  syncSkillRepo,
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
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{SCOPE_LABEL[info.scope]}</span>
          <Badge variant="outline" className="text-[10px]">
            {info.provider}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">••••{info.hint}</span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {info.label ?? "未命名"}
          {info.lastUsedAt
            ? ` · 最近使用 ${new Date(info.lastUsedAt).toLocaleString()}`
            : " · 尚未使用"}
        </p>
      </div>
      {envManaged ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">由环境变量提供</span>
      ) : (
        <Button size="icon" variant="ghost" disabled={busy} onClick={() => void remove()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      )}
    </div>
  );
}

/** 来源令牌 + 平台缓存：解释「为什么装得快」并给出限流的解法 */
export function SkillSettingsPanel() {
  const [tokens, setTokens] = useState<SkillTokenInfo[]>([]);
  const [canManagePlatform, setCanManagePlatform] = useState(false);
  const [cache, setCache] = useState<SkillCacheStatus | null>(null);
  const [scope, setScope] = useState<SkillTokenScope>("tenant");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([listSkillTokens(), fetchSkillCacheStatus()]);
      setTokens(t.tokens);
      setCanManagePlatform(t.canManagePlatform);
      setCache(c);
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
        scope,
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
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">来源令牌</h3>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          GitHub 未鉴权时每小时只允许 60 次 API 调用。配置令牌后额度提升到 5000
          次/小时，也能读取私有仓库。抓取优先用整站令牌，读不到才会用团队令牌——
          用团队令牌拿到的私有内容不会写入跨团队共享缓存。
        </p>

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
          {canManagePlatform ? (
            <div className="flex gap-1.5">
              {(["tenant", "platform"] as SkillTokenScope[]).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={scope === s ? "default" : "outline"}
                  onClick={() => setScope(s)}
                >
                  {scope === s ? <Check className="size-3.5" /> : null}
                  {SCOPE_LABEL[s]}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">GitHub Token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… 或 github_pat_…（只读 public_repo 权限即可）"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">备注</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="可选"
                className="w-40 text-xs"
              />
            </div>
            <Button className="self-end" disabled={!token.trim() || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">平台缓存</h3>
          {cache ? (
            <span className="text-xs text-muted-foreground">
              {cache.repos.length} 个仓库 · {cache.totalSkills} 个技能 ·{" "}
              {formatBytes(cache.totalBytes)}
            </span>
          ) : null}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          技能仓库由服务端统一拉取并定期检查更新，各团队安装时直接从本地读取，
          既不占 GitHub 配额也无需等待下载。
        </p>

        {cache?.repos.length ? (
          <div className="overflow-hidden rounded-xl border border-border">
            {cache.repos.map((repo, i) => (
              <div
                key={repo.repoKey}
                className={cn(
                  "flex items-center gap-3 bg-card px-3.5 py-2.5",
                  i > 0 && "border-t border-border",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
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
                    {repo.checkedAt
                      ? ` · ${new Date(repo.checkedAt).toLocaleString()} 检查`
                      : ""}
                  </p>
                  {repo.lastError ? (
                    <p className="truncate text-[11px] text-destructive">{repo.lastError}</p>
                  ) : null}
                </div>
                <Button
                  size="icon"
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
