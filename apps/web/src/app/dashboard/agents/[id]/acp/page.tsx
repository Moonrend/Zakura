"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Plus, Terminal, Trash2 } from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  SettingsHeader,
  SettingsRow,
  SettingsSaveIndicator,
  SettingsSection,
} from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchAcpConfig,
  saveAcpConfig,
  startAcpDeviceLogin,
  pollAcpDeviceLogin,
  cancelAcpDeviceLogin,
} from "@/lib/acp";
import { WorkspaceTerminalDialog } from "@/components/workspace-terminal-dialog";
import type { AcpAgentConfig, AcpAgentSetup, AcpPublicProfile, AcpSetupMode } from "@zakura/shared";
import {
  missingRequiredAcpField,
  parseAcpAgentSetup,
  publicProfileForSetup,
  ZAKURA_RUNTIME_ID,
} from "@zakura/shared";

export default function AgentAcpPage() {
  const { id } = useAgentDetail();
  const [config, setConfig] = useState<AcpAgentConfig | null>(null);
  const [profiles, setProfiles] = useState<AcpPublicProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customId, setCustomId] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalProfile, setTerminalProfile] = useState<string>();
  const configRef = useRef<AcpAgentConfig | null>(null);

  const persist = useCallback(
    async (patch: Partial<AcpAgentConfig>) => {
      const current = configRef.current;
      if (!current) return;
      const next: AcpAgentConfig = {
        permissionPolicy: patch.permissionPolicy ?? current.permissionPolicy,
        permissionGrants: patch.permissionGrants ?? current.permissionGrants,
        defaultRuntime: patch.defaultRuntime ?? current.defaultRuntime,
        agents: patch.agents ?? current.agents,
      };
      const res = await saveAcpConfig(id, next);
      configRef.current = res.config;
      setConfig(res.config);
      setProfiles(res.profiles);
    },
    [id],
  );

  const { status, error, schedule, saveNow } = useAutoSave(persist);

  const load = useCallback(async () => {
    const res = await fetchAcpConfig(id);
    configRef.current = res.config;
    setConfig(res.config);
    setProfiles(res.profiles);
  }, [id]);

  useEffect(() => {
    void load().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  function commit(next: AcpAgentConfig, immediate = false) {
    configRef.current = next;
    setConfig(next);
    if (immediate) saveNow(next);
    else schedule(next);
  }

  function patch(fn: (prev: AcpAgentConfig) => AcpAgentConfig, immediate = false) {
    const current = configRef.current;
    if (!current) return;
    commit(fn(current), immediate);
  }

  function upsert(setup: AcpAgentSetup, immediate = false) {
    patch((prev) => ({ ...prev, agents: { ...prev.agents, [setup.id]: setup } }), immediate);
  }

  if (!config) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const catalog = profiles.length
    ? profiles
    : Object.values(config.agents).map((s) => publicProfileForSetup(s));
  const selectedProfile = selectedId ? (catalog.find((p) => p.id === selectedId) ?? null) : null;
  const selectedSetup = selectedProfile
    ? (config.agents[selectedProfile.id] ??
      parseAcpAgentSetup(selectedProfile.id, { enabled: false, setupMode: "api_key" }))
    : null;

  if (selectedProfile && selectedSetup) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            <ChevronLeft className="size-4" />
            ACP Agent
          </Button>
          <SettingsSaveIndicator status={status} error={error} />
        </div>
        <SettingsSection title={selectedProfile.displayName}>
          <p className="px-1 text-xs text-muted-foreground">{selectedProfile.description}</p>
          {selectedProfile.builtin ? (
            <p className="px-1 text-xs text-muted-foreground">适配器已预装在工作区镜像中，随镜像更新。</p>
          ) : null}
          <SettingsRow
            label="模型来源"
            description="Zakura 路由会覆盖此 Agent 的模型设置，并沿用 Zakura 的路由、容灾与用量记录。"
          >
            <Select
              value={selectedSetup.modelProvider ?? "native"}
              onValueChange={(value) => {
                if (value === "native" || value === "zakura") {
                  upsert({ ...selectedSetup, modelProvider: value }, true);
                }
              }}
              items={[
                { value: "native", label: "Agent 自身" },
                { value: "zakura", label: "Zakura 路由" },
              ]}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="native">Agent 自身</SelectItem>
                <SelectItem value="zakura">Zakura 路由</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          {selectedSetup.modelProvider === "zakura" ? (
            <SettingsRow
              label="模型"
              description="可填 Zakura 模型别名；留空时使用该 Agent 的默认 chat 路由。"
            >
              <Input
                className="max-w-72 font-mono"
                placeholder="留空使用默认路由"
                value={selectedSetup.managed.model ?? ""}
                onChange={(e) =>
                  upsert({
                    ...selectedSetup,
                    managed: { ...selectedSetup.managed, model: e.target.value },
                  })
                }
              />
            </SettingsRow>
          ) : null}
          {selectedSetup.modelProvider !== "zakura" ? <SettingsRow label="登录方式">
            <Select
              value={selectedSetup.setupMode}
              onValueChange={(v) => {
                if (v === "api_key" || v === "oauth" || v === "self") {
                  upsert({ ...selectedSetup, setupMode: v }, true);
                  if (v === "self") {
                    setTerminalProfile(selectedProfile.displayName);
                    setTerminalOpen(true);
                  }
                }
              }}
              items={setupModeItems(selectedProfile.setupModes)}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {setupModeItems(selectedProfile.setupModes).map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow> : null}
          {selectedSetup.modelProvider !== "zakura" && selectedSetup.setupMode === "api_key"
            ? selectedProfile.managedFields
                .filter((field) => field.id !== "oauth_token")
                .map((field) => (
                  <SettingsRow key={field.id} label={field.label} description={field.help}>
                    <Input
                      type={field.type === "password" ? "password" : "text"}
                      className="max-w-72"
                      placeholder={field.placeholder}
                      value={selectedSetup.managed[field.id] ?? ""}
                      onChange={(e) =>
                        upsert({
                          ...selectedSetup,
                          managed: { ...selectedSetup.managed, [field.id]: e.target.value },
                        })
                      }
                    />
                  </SettingsRow>
                ))
            : null}
          {selectedSetup.modelProvider !== "zakura" && selectedSetup.setupMode === "oauth" ? (
            <>
              {selectedProfile.id === "claude-code" ? (
                <>
                  <p className="px-1 text-xs text-muted-foreground">
                    在本机运行 <span className="font-mono">claude setup-token</span>{" "}
                    后把 token 贴到下面。订阅 token 给 Agent SDK 可能被 Anthropic 拒绝，失败请改用 API
                    key。
                  </p>
                  {selectedProfile.managedFields
                    .filter((field) => field.id === "oauth_token")
                    .map((field) => (
                      <SettingsRow key={field.id} label={field.label} description={field.help}>
                        <Input
                          type="password"
                          className="max-w-72"
                          placeholder={field.placeholder}
                          value={selectedSetup.managed[field.id] ?? ""}
                          onChange={(e) =>
                            upsert({
                              ...selectedSetup,
                              managed: { ...selectedSetup.managed, [field.id]: e.target.value },
                            })
                          }
                        />
                      </SettingsRow>
                    ))}
                </>
              ) : null}
              {selectedProfile.id === "codex" ? <CodexDevicePanel agentId={id} /> : null}
              <p className="px-1 text-xs text-muted-foreground">
                {selectedProfile.id === "claude-code" || selectedProfile.id === "codex"
                  ? "也可以在聊天里走 ACP 协议登录。"
                  : "聊天里第一次遇到 auth_required 时会弹出协议登录。"}
              </p>
            </>
          ) : null}
          {selectedSetup.modelProvider !== "zakura" && selectedSetup.setupMode === "self" ? (
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                登录文件保存在工作区卷中。可直接进入容器执行登录或调整当前版本的 ACP 命令。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setTerminalProfile(selectedProfile.displayName);
                  setTerminalOpen(true);
                }}
              >
                <Terminal className="size-3.5" />
                进入容器内配置
              </Button>
            </div>
          ) : null}
          {!selectedProfile.builtin ? (
            <>
              <SettingsRow label="命令">
                <Input
                  className="max-w-72 font-mono"
                  value={selectedSetup.command ?? ""}
                  onChange={(e) => upsert({ ...selectedSetup, command: e.target.value })}
                />
              </SettingsRow>
              <SettingsRow label="参数" description="空格分隔">
                <Input
                  className="max-w-72 font-mono"
                  value={(selectedSetup.args ?? []).join(" ")}
                  onChange={(e) =>
                    upsert({
                      ...selectedSetup,
                      args: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [],
                    })
                  }
                />
              </SettingsRow>
              <div className="px-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    patch((prev) => {
                      const agents = { ...prev.agents };
                      delete agents[selectedProfile.id];
                      return { ...prev, agents };
                    }, true);
                    setSelectedId(null);
                  }}
                >
                  <Trash2 className="mr-1 size-3.5" />
                  删除
                </Button>
              </div>
            </>
          ) : null}
        </SettingsSection>
        <WorkspaceTerminalDialog
          agentId={id}
          request={{ profileId: selectedProfile.id, profileName: terminalProfile }}
          open={terminalOpen}
          onOpenChange={setTerminalOpen}
        />
      </div>
    );
  }

  const enabledOptions = Object.values(config.agents)
    .filter((a) => a.enabled)
    .map((a) => ({
      value: a.id,
      label: a.displayName || catalog.find((p) => p.id === a.id)?.displayName || a.id,
    }));

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="ACP Agent"
        description="第三方编码 Agent 已打进工作区镜像。在这里启用、登录，聊天里按对话选择执行方。"
        actions={<SettingsSaveIndicator status={status} error={error} />}
      />

      <SettingsSection title="对话">
        <SettingsRow
          label="默认执行方"
          description="新对话用这个；composer 仍可改。已有消息的会话不会改绑。"
        >
          <Select
            value={config.defaultRuntime || ZAKURA_RUNTIME_ID}
            onValueChange={(v) => {
              if (!v) return;
              patch((p) => ({ ...p, defaultRuntime: v }), true);
            }}
            items={[{ value: ZAKURA_RUNTIME_ID, label: "Zakura" }, ...enabledOptions]}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ZAKURA_RUNTIME_ID}>Zakura</SelectItem>
              {enabledOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="工具授权"
          description="ask = 每次确认；allow = 自动允许（仅信任的 Agent）"
        >
          <Select
            value={config.permissionPolicy}
            onValueChange={(v) => {
              if (v === "ask" || v === "allow") {
                patch((p) => ({ ...p, permissionPolicy: v }), true);
              }
            }}
            items={[
              { value: "ask", label: "每次询问" },
              { value: "allow", label: "自动允许" },
            ]}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">每次询问</SelectItem>
              <SelectItem value="allow">自动允许</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="始终允许"
          description={
            config.permissionGrants.length
              ? `已记住 ${config.permissionGrants.length} 条`
              : "在聊天里点「始终允许」后会记在这里"
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!config.permissionGrants.length}
            onClick={() => patch((p) => ({ ...p, permissionGrants: [] }), true)}
          >
            清空
          </Button>
        </SettingsRow>
      </SettingsSection>

      <div className="space-y-2">
        {catalog.map((profile) => {
          const setup =
            config.agents[profile.id] ??
            parseAcpAgentSetup(profile.id, { enabled: false, setupMode: "api_key" });
          const row = rowState(profile, setup);
          return (
            <div
              key={profile.id}
              className="relative flex items-center gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors hover:bg-muted/40"
            >
              <button
                type="button"
                className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={profile.displayName}
                onClick={() => setSelectedId(profile.id)}
              />
              <span className="pointer-events-none relative flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                {(profile.displayName || profile.id).slice(0, 1).toUpperCase()}
                {row === "on_ready" ? (
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-card" />
                ) : null}
              </span>
              <span className="pointer-events-none min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {profile.displayName || profile.id}
                </span>
                {profile.description ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {profile.description}
                  </span>
                ) : null}
              </span>
              <div className="relative z-10 flex shrink-0 items-center gap-3">
                {row === "on_needs_config" ? (
                  <Badge variant="warn">待配置</Badge>
                ) : null}
                {row === "off_configured" ? (
                  <Badge variant="outline">已关闭</Badge>
                ) : null}
                <ChevronRight className="pointer-events-none size-4 text-muted-foreground/60" />
                <Switch
                  checked={setup.enabled}
                  aria-label={`启用 ${profile.displayName}`}
                  onCheckedChange={(enabled) => {
                    upsert({ ...setup, enabled }, true);
                    if (enabled && missingRequiredAcpField(profile, { ...setup, enabled })) {
                      setSelectedId(profile.id);
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <SettingsSection title="自定义命令">
        <SettingsRow label="profile id" description="仅自定义入口需要；内置适配器不用安装">
          <div className="flex gap-2">
            <Input
              className="max-w-48 font-mono"
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder="my-cli"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const nextId = customId.trim().toLowerCase();
                if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(nextId)) {
                  toast.error("id 不合法");
                  return;
                }
                if (config.agents[nextId] || catalog.some((p) => p.id === nextId)) {
                  toast.error("已存在");
                  return;
                }
                upsert(
                  {
                    id: nextId,
                    enabled: true,
                    setupMode: "self",
                    displayName: nextId,
                    command: nextId,
                    args: [],
                    managed: {},
                  },
                  true,
                );
                setCustomId("");
                setSelectedId(nextId);
              }}
            >
              <Plus className="mr-1 size-3.5" />
              添加
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>
      <WorkspaceTerminalDialog
        agentId={id}
        request={terminalProfile ? { profileName: terminalProfile } : undefined}
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
      />
    </div>
  );
}

function rowState(
  profile: AcpPublicProfile,
  setup: AcpAgentSetup,
): "off_empty" | "off_configured" | "on_needs_config" | "on_ready" {
  const hasCredentials = Object.values(setup.managed).some((v) => v.trim() !== "");
  if (!setup.enabled) return hasCredentials ? "off_configured" : "off_empty";
  return missingRequiredAcpField(profile, setup) ? "on_needs_config" : "on_ready";
}

function setupModeItems(modes: AcpSetupMode[]) {
  const labels: Record<AcpSetupMode, string> = {
    api_key: "API key",
    oauth: "OAuth",
    self: "容器内已登录",
  };
  return modes.map((value) => ({ value, label: labels[value] }));
}

function CodexDevicePanel({ agentId }: { agentId: string }) {
  const [snap, setSnap] = useState<{
    loginId: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    status: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!snap || snap.status !== "pending") return;
    const t = window.setTimeout(() => {
      void pollAcpDeviceLogin(agentId, "codex", snap.loginId)
        .then(setSnap)
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    }, Math.max(2, snap.interval || 5) * 1000);
    return () => window.clearTimeout(t);
  }, [agentId, snap]);

  return (
    <div className="space-y-2 px-1">
      {snap ? (
        <>
          <p className="text-xs text-muted-foreground">
            打开{" "}
            <a href={snap.verificationUrl} target="_blank" rel="noreferrer" className="underline">
              {snap.verificationUrl}
            </a>
            ，输入代码{" "}
            <span className="font-mono text-foreground">{snap.userCode}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {snap.status === "pending"
              ? "等待确认…"
              : snap.status === "complete"
                ? "已写入工作区 auth.json"
                : snap.error || snap.status}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (snap.status === "pending") {
                void cancelAcpDeviceLogin(agentId, "codex", snap.loginId).catch(() => undefined);
              }
              setSnap(null);
            }}
          >
            取消
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void startAcpDeviceLogin(agentId, "codex")
              .then(setSnap)
              .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
          }}
        >
          开始设备码登录
        </Button>
      )}
    </div>
  );
}
