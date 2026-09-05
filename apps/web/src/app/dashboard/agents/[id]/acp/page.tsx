"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Download, Loader2, Plus, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { useAgentDetail } from "@/components/agent-detail-context";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { PageLoading } from "@/components/ui/progress-linear";
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
  probeAcpAdapter,
  installAcpAdapter,
  fetchAcpAdapterStatus,
  type AcpAdapterStatus,
} from "@/lib/acp";
const WorkspaceTerminalDialog = dynamic(
  () => import("@/components/workspace-terminal-dialog").then((m) => m.WorkspaceTerminalDialog),
  { ssr: false },
);
import type { AcpAgentConfig, AcpAgentSetup, AcpManagedField, AcpPublicProfile, AcpSetupMode } from "@zakura/shared";
import {
  acpManualSetupCommand,
  isMaskedAcpSecret,
  missingRequiredAcpField,
  parseAcpAgentSetup,
  publicProfileForSetup,
  supportsAcpZakuraRoute,
  ZAKURA_RUNTIME_ID,
} from "@zakura/shared";

export default function AgentAcpPage() {
  const { id } = useAgentDetail();
  const { confirm } = useConfirmDialog();
  const [config, setConfig] = useState<AcpAgentConfig | null>(null);
  const [profiles, setProfiles] = useState<AcpPublicProfile[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customId, setCustomId] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalProfile, setTerminalProfile] = useState<string>();
  const [terminalProfileId, setTerminalProfileId] = useState<string>();
  const configRef = useRef<AcpAgentConfig | null>(null);
  const [adapterStatuses, setAdapterStatuses] = useState<AcpAdapterStatus[]>([]);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installingIsUpdate, setInstallingIsUpdate] = useState(false);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, { installed: boolean; output: string }>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);

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
      // 保存响应里的敏感字段是掩码；直接回填会把正在输入框里编辑的内容
      // 覆盖成 ***xxxx。本地仍在编辑（非掩码）时保留本地值。
      const merged = preserveEditingSecrets(next, res.config);
      configRef.current = merged;
      setConfig(merged);
      setProfiles(res.profiles);
      setConfigError(res.configError ?? null);
    },
    [id],
  );

  const { status, error, schedule, saveNow } = useAutoSave(persist);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [res, adapters] = await Promise.all([
        fetchAcpConfig(id),
        fetchAcpAdapterStatus(id).catch(() => []),
      ]);
      configRef.current = res.config;
      setConfig(res.config);
      setProfiles(res.profiles);
      setConfigError(res.configError ?? null);
      setAdapterStatuses(adapters);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      toast.error(message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function commit(next: AcpAgentConfig, immediate = false) {
    configRef.current = next;
    setConfig(next);
    if (immediate) saveNow(next);
    else schedule(next);
  }

  /** 敏感字段编辑只改本地状态：每个按键都触发防抖保存会把没输完的 key 存库。 */
  function commitLocal(next: AcpAgentConfig) {
    configRef.current = next;
    setConfig(next);
  }

  function patch(fn: (prev: AcpAgentConfig) => AcpAgentConfig, immediate = false) {
    const current = configRef.current;
    if (!current) return;
    commit(fn(current), immediate);
  }

  function upsert(setup: AcpAgentSetup, immediate = false) {
    patch((prev) => ({ ...prev, agents: { ...prev.agents, [setup.id]: setup } }), immediate);
  }

  function upsertLocal(setup: AcpAgentSetup) {
    const current = configRef.current;
    if (!current) return;
    commitLocal({
      ...current,
      agents: { ...current.agents, [setup.id]: setup },
    });
  }

  function openTerminal(profile: AcpPublicProfile) {
    setTerminalProfile(profile.displayName);
    setTerminalProfileId(profile.id);
    setTerminalOpen(true);
  }

  async function handleProbe(profileId: string) {
    try {
      const result = await probeAcpAdapter(id, profileId);
      setProbeResults((prev) => ({ ...prev, [profileId]: result }));
      if (result.installed) {
        toast.success(`${profileId} 已就绪`);
      } else {
        toast.info(`${profileId} 未安装`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleInstall(profileId: string, isUpdate = false) {
    setInstallingId(profileId);
    setInstallingIsUpdate(isUpdate);
    setInstallOutput(null);
    try {
      const result = await installAcpAdapter(id, profileId);
      setInstallOutput(result.output);
      if (result.ok) {
        toast.success(isUpdate ? `${profileId} 已更新到最新版本` : `${profileId} 安装完成`);
        setProbeResults((prev) => ({ ...prev, [profileId]: { installed: true, output: result.output } }));
        void fetchAcpAdapterStatus(id).then(setAdapterStatuses).catch(() => {});
      } else {
        toast.error(isUpdate ? `${profileId} 更新失败` : `${profileId} 安装失败`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallOutput(msg);
      toast.error(msg);
    } finally {
      setInstallingId(null);
      setInstallingIsUpdate(false);
    }
  }

  /**
   * Re-reads the registry index with `refresh=1`. The plain `load()` path is
   * served from a 6h-TTL cache, so without this a freshly published version
   * stays invisible for hours and the "更新" button never appears.
   */
  async function handleCheckUpdates() {
    setCheckingUpdates(true);
    try {
      const next = await fetchAcpAdapterStatus(id, { refresh: true });
      setAdapterStatuses(next);
      const count = next.filter((a) => a.updateAvailable).length;
      if (count > 0) toast.success(`发现 ${count} 个适配器有更新`);
      else toast.info("所有适配器均为最新版本");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  function getAdapterInstallInfo(profileId: string) {
    const status = adapterStatuses.find((a) => a.id === profileId);
    const probe = probeResults[profileId];
    return { status, probe };
  }

  if (!config) {
    if (loadError) {
      return (
        <div className="space-y-4">
          <SettingsHeader title="ACP Agent" description="配置加载失败" />
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4">
            <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        </div>
      );
    }
    return <PageLoading />;
  }

  const catalog = profiles.length
    ? profiles
    : Object.values(config.agents).map((s) => publicProfileForSetup(s));
  const selectedProfile = selectedId ? (catalog.find((p) => p.id === selectedId) ?? null) : null;
  const selectedSetup: AcpAgentSetup = selectedProfile
    ? (config.agents[selectedProfile.id] ??
      parseAcpAgentSetup(selectedProfile.id, { enabled: false, setupMode: "api_key" }))
    : parseAcpAgentSetup("_unused", { enabled: false, setupMode: "api_key" });

  if (selectedProfile && selectedSetup) {
    const supportsZakura = supportsAcpZakuraRoute(selectedProfile);
    const modelProvider =
      supportsZakura && selectedSetup.modelProvider === "zakura" ? "zakura" : "native";
    const manualCommand = acpManualSetupCommand(selectedProfile.id);
    return (
      <div className="space-y-6">
        <ConfigErrorBanner error={configError} />
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            <ChevronLeft className="size-4" />
            ACP Agent
          </Button>
          <SettingsSaveIndicator status={status} error={error} />
        </div>
        <SettingsSection title={selectedProfile.displayName}>
          <p className="px-1 text-xs text-muted-foreground">{selectedProfile.description}</p>
          {selectedProfile.preinstalled ? (
            <p className="px-1 text-xs text-muted-foreground">适配器随工作区镜像出厂，无需安装。</p>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              适配器按需安装到工作区（首次启动会自动装），可随时点「安装 / 更新」升到最新版本。
            </p>
          )}
          <SettingsRow
            label="模型来源"
            description="Zakura 路由会覆盖 Agent 模型设置"
          >
            <Select
              value={modelProvider}
              onValueChange={(value) => {
                if (value === "native" || (value === "zakura" && supportsZakura)) {
                  upsert({ ...selectedSetup, modelProvider: value }, true);
                }
              }}
              items={[
                { value: "native", label: "Agent 自身" },
                ...(supportsZakura ? [{ value: "zakura", label: "Zakura 路由" }] : []),
              ]}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="native">Agent 自身</SelectItem>
                {supportsZakura ? <SelectItem value="zakura">Zakura 路由</SelectItem> : null}
              </SelectContent>
            </Select>
          </SettingsRow>
          {!supportsZakura ? (
            <p className="px-1 text-xs text-muted-foreground">
              此 Agent 使用厂商专用协议，当前 Zakura Gateway 只提供 OpenAI 兼容接口，因此请使用 Agent 自身配置。
            </p>
          ) : null}
          {modelProvider === "zakura" ? (
            <SettingsRow
              label="模型"
              description="留空使用默认路由"
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
          {modelProvider !== "zakura" ? <SettingsRow label="登录方式">
            <Select
              value={selectedSetup.setupMode}
              onValueChange={(v) => {
                if (v === "api_key" || v === "oauth" || v === "self") {
                  upsert({ ...selectedSetup, setupMode: v }, true);
                  if (v === "self") openTerminal(selectedProfile);
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
          {modelProvider !== "zakura" && selectedSetup.setupMode === "api_key"
            ? selectedProfile.managedFields
                .filter((field) => field.id !== "oauth_token")
                .map((field) => (
                  <ManagedFieldRow
                    key={field.id}
                    field={field}
                    setup={selectedSetup}
                    onSensitiveChange={(value) =>
                      upsertLocal({
                        ...selectedSetup,
                        managed: { ...selectedSetup.managed, [field.id]: value },
                      })
                    }
                    onSensitiveCommit={() => {
                      const current = configRef.current;
                      if (current) saveNow(current);
                    }}
                    onChange={(value) =>
                      upsert({
                        ...selectedSetup,
                        managed: { ...selectedSetup.managed, [field.id]: value },
                      })
                    }
                  />
                ))
            : null}
          {modelProvider !== "zakura" && selectedSetup.setupMode === "oauth" ? (
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
                      <ManagedFieldRow
                        key={field.id}
                        field={field}
                        setup={selectedSetup}
                        onSensitiveChange={(value) =>
                          upsertLocal({
                            ...selectedSetup,
                            managed: { ...selectedSetup.managed, [field.id]: value },
                          })
                        }
                        onSensitiveCommit={() => {
                      const current = configRef.current;
                      if (current) saveNow(current);
                    }}
                        onChange={() => undefined}
                      />
                    ))}
                </>
              ) : null}
              {selectedProfile.id === "codex" ? <CodexDevicePanel agentId={id} /> : null}
              {selectedProfile.id !== "claude-code" && selectedProfile.id !== "codex" ? (
                <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3">
                  <p className="min-w-0 text-xs text-muted-foreground">
                    该 Agent 没有网页版登录：在容器里运行{" "}
                    <span className="font-mono">{manualCommand.display}</span>{" "}
                    完成登录；聊天里遇到 auth_required 时也会弹出协议登录。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openTerminal(selectedProfile)}
                  >
                    <Terminal className="size-3.5" />
                    进入容器登录
                  </Button>
                </div>
              ) : null}
              {selectedProfile.id === "claude-code" || selectedProfile.id === "codex" ? (
                <p className="px-1 text-xs text-muted-foreground">也可以在聊天里走 ACP 协议登录。</p>
              ) : null}
            </>
          ) : null}
          {modelProvider !== "zakura" && selectedSetup.setupMode === "self" ? (
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                登录文件保存在工作区卷中。终端会自动运行{" "}
                <span className="font-mono">{manualCommand.display}</span>，登录一次即可。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => openTerminal(selectedProfile)}
              >
                <Terminal className="size-3.5" />
                进入容器内配置
              </Button>
            </div>
          ) : null}
          {!selectedProfile.managed ? (
            <>
              <SettingsRow label="命令">
                <Input
                  className="max-w-72 font-mono"
                  value={selectedSetup.command ?? ""}
                  onChange={(e) => upsert({ ...selectedSetup, command: e.target.value })}
                />
              </SettingsRow>
              <SettingsRow label="参数" description="空格分隔；含空格的参数用引号包裹">
                <Input
                  className="max-w-72 font-mono"
                  value={(selectedSetup.args ?? [])
                    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
                    .join(" ")}
                  onChange={(e) =>
                    upsert({
                      ...selectedSetup,
                      args: splitShellArgs(e.target.value),
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
                    void (async () => {
                      const ok = await confirm({
                        title: `删除自定义 Agent「${selectedProfile.displayName}」？`,
                        description: "已保存的命令与凭证会一并移除。",
                        confirmLabel: "删除",
                        destructive: true,
                      });
                      if (!ok) return;
                      patch((prev) => {
                        const agents = { ...prev.agents };
                        delete agents[selectedProfile.id];
                        return { ...prev, agents };
                      }, true);
                      setSelectedId(null);
                    })();
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
        description="第三方编码 Agent 配置"
        actions={<SettingsSaveIndicator status={status} error={error} />}
      />
      <ConfigErrorBanner error={configError} />

      <SettingsSection title="对话">
        <SettingsRow
          label="默认执行方"
          description="新对话默认使用"
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
          description="ask 每次确认，allow 自动允许"
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
        {config.permissionGrants.length ? (
          <div className="space-y-2 px-1">
            <p className="text-xs text-muted-foreground">
              已记住 {config.permissionGrants.length} 条「始终允许」，按工具类型与路径匹配：
            </p>
            <div className="flex flex-wrap gap-1.5">
              {config.permissionGrants.map((grant, index) => (
                <span
                  key={`${grant.kind}|${grant.pathPrefix ?? ""}|${index}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs"
                >
                  <span className="truncate">
                    {grant.kind}
                    {grant.pathPrefix ? ` · ${grant.pathPrefix}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label="移除此授权"
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() =>
                      patch(
                        (p) => ({
                          ...p,
                          permissionGrants: p.permissionGrants.filter((_, i) => i !== index),
                        }),
                        true,
                      )
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => patch((p) => ({ ...p, permissionGrants: [] }), true)}
            >
              清空全部
            </Button>
          </div>
        ) : (
          <SettingsRow label="始终允许" description="在聊天里点「始终允许」后会记在这里">
            <span className="text-xs text-muted-foreground">暂无记录</span>
          </SettingsRow>
        )}
      </SettingsSection>

      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <p className="text-xs text-muted-foreground">
            更新检查每 6 小时自动刷新一次，点右侧可立即重查。
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCheckUpdates}
            disabled={checkingUpdates}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checkingUpdates ? "animate-spin" : ""}`} />
            {checkingUpdates ? "检查中…" : "检查更新"}
          </Button>
        </div>
        {catalog.map((profile) => {
          const setup =
            config.agents[profile.id] ??
            parseAcpAgentSetup(profile.id, { enabled: false, setupMode: "api_key" });
          const row = rowState(profile, setup);
          const { status: adapterStatus, probe } = getAdapterInstallInfo(profile.id);
          const isInstalling = installingId === profile.id;
          const isInstalled = probe?.installed || (adapterStatus?.installed?.length ?? 0) > 0;
          const hasUpdate = adapterStatus?.updateAvailable;
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
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-success ring-2 ring-card" />
                ) : null}
              </span>
              <span className="pointer-events-none min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {profile.displayName || profile.id}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  {profile.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {profile.description}
                    </span>
                  ) : null}
                  {isInstalled ? (
                    <Badge variant="outline" className="pointer-events-auto gap-0.5 text-[10px] text-success">
                      <Check className="size-2.5" /> 已安装
                      {adapterStatus?.installed?.[0] ? ` v${adapterStatus.installed[0]}` : ""}
                    </Badge>
                  ) : null}
                  {hasUpdate ? (
                    <Badge variant="warn" className="pointer-events-auto gap-0.5 text-[10px]">
                      有更新 → {adapterStatus?.latest}
                    </Badge>
                  ) : null}
                </span>
              </span>
              <div className="relative z-10 flex shrink-0 items-center gap-3">
                {setup.enabled && (hasUpdate || !isInstalled) && !isInstalling ? (
                  <Button
                    type="button"
                    variant={hasUpdate ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={(e) => { e.stopPropagation(); void handleInstall(profile.id, Boolean(hasUpdate)); }}
                  >
                    {hasUpdate ? <RefreshCw className="mr-1 size-3" /> : <Download className="mr-1 size-3" />}
                    {hasUpdate ? "更新" : "安装"}
                  </Button>
                ) : null}
                {isInstalling ? (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Loader2 className="size-3 animate-spin" /> {installingIsUpdate ? "更新中…" : "安装中…"}
                  </Badge>
                ) : null}
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

      {installOutput ? (
        <SettingsSection title="安装日志">
          <div className="max-h-48 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {installOutput}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 text-xs text-muted-foreground"
            onClick={() => setInstallOutput(null)}
          >
            关闭
          </Button>
        </SettingsSection>
      ) : null}

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
        request={terminalProfileId ? { profileId: terminalProfileId, profileName: terminalProfile } : undefined}
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
      />
    </div>
  );
}

/** 保存响应中的敏感字段是掩码；本地正在编辑（非掩码值）时保留本地展示。 */
function preserveEditingSecrets(local: AcpAgentConfig, server: AcpAgentConfig): AcpAgentConfig {
  const agents: Record<string, AcpAgentSetup> = {};
  for (const [agentId, serverSetup] of Object.entries(server.agents)) {
    const localSetup = local.agents[agentId];
    if (!localSetup) {
      agents[agentId] = serverSetup;
      continue;
    }
    const managed: Record<string, string> = {};
    for (const [key, serverValue] of Object.entries(serverSetup.managed)) {
      const localValue = localSetup.managed[key];
      managed[key] =
        isMaskedAcpSecret(serverValue) && localValue && !isMaskedAcpSecret(localValue)
          ? localValue
          : serverValue;
    }
    agents[agentId] = { ...serverSetup, managed };
  }
  return { ...server, agents };
}

/**
 * configJson 损坏时服务端只能返回空配置（页面显示为「全部未配置」）。
 * 显式提醒用户，避免误以为配置丢失；任意一次保存都会重写为合法 JSON。
 */
function ConfigErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <p className="min-w-0 text-xs text-muted-foreground">
        Agent 配置文件解析失败（{error}），下方显示的是空配置。原数据可能仍在；
        修改任意设置并保存即可重写为合法配置；如需找回原内容请联系管理员检查数据库。
      </p>
    </div>
  );
}

/** 引号感知的参数切分：`--flag "a b" c` → ["--flag", "a b", "c"]。 */
function splitShellArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value) out.push(value);
  }
  return out;
}

/**
 * 表单字段行。普通字段随输入防抖保存；敏感字段（API key / token）只在
 * 失焦时保存——防抖期间每个按键都会把未输完的 key 写进数据库。
 */
function ManagedFieldRow({
  field,
  setup,
  onChange,
  onSensitiveChange,
  onSensitiveCommit,
}: {
  field: AcpManagedField;
  setup: AcpAgentSetup;
  onChange: (value: string) => void;
  onSensitiveChange: (value: string) => void;
  onSensitiveCommit: () => void;
}) {
  const sensitive = field.type === "password" || field.sensitive === true;
  const value = setup.managed[field.id] ?? "";
  return (
    <SettingsRow
      label={field.required ? `${field.label} *` : field.label}
      description={field.help}
    >
      <Input
        type={field.type === "password" ? "password" : "text"}
        inputMode={field.type === "url" ? "url" : undefined}
        className="max-w-72"
        placeholder={field.placeholder}
        value={value}
        autoComplete="off"
        onChange={(e) => (sensitive ? onSensitiveChange(e.target.value) : onChange(e.target.value))}
        onBlur={() => {
          if (sensitive) onSensitiveCommit();
        }}
      />
    </SettingsRow>
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

type DeviceLoginSnap = {
  loginId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn?: number;
  status: string;
  error?: string;
};

function CodexDevicePanel({ agentId }: { agentId: string }) {
  const [snap, setSnap] = useState<DeviceLoginSnap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!snap || snap.status !== "pending" || error) return;
    const t = window.setTimeout(() => {
      void pollAcpDeviceLogin(agentId, "codex", snap.loginId)
        .then((next) => {
          setError(null);
          setSnap(next);
        })
        .catch((err) => {
          // 记录错误并停住轮询；界面给出重试入口，而不是永远停在「等待确认」。
          setError(err instanceof Error ? err.message : String(err));
        });
    }, Math.max(2, snap.interval || 5) * 1000);
    return () => window.clearTimeout(t);
  }, [agentId, snap, error]);

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
            {error
              ? `轮询失败：${error}`
              : snap.status === "pending"
                ? `等待确认…${snap.expiresIn ? `（代码约 ${Math.round(snap.expiresIn / 60)} 分钟内有效）` : ""}`
                : snap.status === "complete"
                  ? "已写入工作区 auth.json"
                  : snap.error || snap.status}
          </p>
          <div className="flex gap-2">
            {error && snap.status === "pending" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setError(null)}
              >
                重试轮询
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (snap.status === "pending" && !error) {
                  void cancelAcpDeviceLogin(agentId, "codex", snap.loginId).catch(() => undefined);
                }
                setSnap(null);
                setError(null);
              }}
            >
              取消
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void startAcpDeviceLogin(agentId, "codex")
              .then((next) => {
                setError(null);
                setSnap(next);
              })
              .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
          }}
        >
          开始设备码登录
        </Button>
      )}
    </div>
  );
}
