"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { SettingsSection } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  deleteSkillToken,
  formatRelative,
  listSkillTokens,
  saveSkillToken,
  type SkillTokenInfo,
} from "@/lib/skills";

export function PlatformSkillTokenPanel() {
  const [token, setToken] = useState<SkillTokenInfo | null>(null);
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listSkillTokens();
      if (!res.canManagePlatform) {
        setForbidden(true);
        return;
      }
      setToken(res.tokens.find((t) => t.scope === "platform") ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|平台管理员|权限/i.test(msg)) setForbidden(true);
      else toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await saveSkillToken({
        provider: "github",
        token: value.trim(),
        scope: "platform",
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      toast.success("整站 GitHub 令牌已保存");
      setValue("");
      setLabel("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await deleteSkillToken("github", "platform");
      toast.success("已移除整站令牌");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  }

  if (forbidden) return null;

  if (loading) {
    return (
      <SettingsSection title="技能来源令牌">
        <PageLoading />
      </SettingsSection>
    );
  }

  const envManaged = token?.label === "GITHUB_TOKEN 环境变量";

  return (
    <SettingsSection title="技能来源令牌">
      <div className="flex flex-wrap items-center gap-2">
        {token ? (
          <>
            <Badge variant="default">已配置</Badge>
            <span className="font-mono text-xs text-muted-foreground">••••{token.hint}</span>
            <span className="text-xs text-muted-foreground">
              {token.label ?? "未命名"} ·{" "}
              {token.lastUsedAt ? `最近使用 ${formatRelative(token.lastUsedAt)}` : "尚未使用"}
            </span>
            {envManaged ? (
              <span className="text-xs text-muted-foreground">由环境变量提供，改这里会覆盖它</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={removing}
                onClick={() => void remove()}
              >
                {removing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                移除
              </Button>
            )}
          </>
        ) : (
          <Badge variant="secondary">未配置</Badge>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="platform-gh-pat">GitHub Token</Label>
          <Input
            id="platform-gh-pat"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ghp_… 或 github_pat_…（只读 public_repo 权限即可）"
            className="font-mono text-xs"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="platform-gh-label">备注</Label>
          <Input
            id="platform-gh-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="可选"
            className="text-xs sm:w-40"
          />
        </div>
        <Button
          className="sm:self-end"
          disabled={!value.trim() || saving}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {token ? "替换" : "保存"}
        </Button>
      </div>
    </SettingsSection>
  );
}
