/**
 * ACP 会话：在 workspace 容器里拉起第三方 Agent，把协议事件写入 Cloud 会话。
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_WORKSPACE_ROOT,
  acpApiKeyDotenv,
  acpRuntimeLayout,
  acpStageScript,
  acpStdioArgv,
  acpSyncBackScript,
  isPathUnderRoots,
  listEnabledAcpSetups,
  missingRequiredAcpField,
  pathPrefixFromLocations,
  pickGrantedOptionId,
  projectDefaultWorkingDir,
  parseAcpSessionModelState,
  ACP_UNSTABLE_MODEL_CONFIG_ID,
  publicProfileForSetup,
  resolveAcpLaunch,
  upsertAcpGrant,
  type AcpAgentSetup,
  type AcpPermissionGrant,
  type AcpRuntimeLayout,
  type AcpRuntimeStatus,
} from "@zakura/shared";
import { newId } from "../../db/schema.js";
import type { Agent } from "../../db/schema.js";
import type { AgentService } from "../agents.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import { AgentHooksService, firstDeny } from "../agent-hooks.js";
import { readAgentAcpConfig, saveAgentAcpConfig } from "./config.js";
import { appendAcpUpdate, type AcpSessionUpdate } from "./events.js";
import {
  settleAll,
  shouldReapAcpRuntime,
  type PendingDecision,
} from "./permissions.js";
import { CodexDeviceAuth } from "./codex-device.js";

type PendingPermission = PendingDecision<acp.RequestPermissionResponse> & {
  kind?: string;
  pathPrefix?: string;
  optionKinds: Record<string, string>;
};

type LiveRuntime = {
  id: string;
  profileId: string;
  chatSessionId: string;
  acpSessionId?: string;
  cwd: string;
  extraRoots: string[];
  kill: () => Promise<void>;
  connection: acp.ClientConnection;
  active?: acp.ActiveSession;
  assistantText: string;
  assistantMessageId: string;
  thoughtMessageId: string;
  runId?: string;
  lastUsedAt: number;
  availableCommands: Array<{ name: string; description?: string }>;
  currentModeId?: string;
  models?: AcpRuntimeStatus["models"];
  reasoning?: AcpRuntimeStatus["reasoning"];
  terminals: Map<string, { outputByteLimit?: number }>;
  permissionGrants: AcpPermissionGrant[];
  permissions: Map<string, PendingPermission>;
  elicitations: Map<string, PendingDecision<acp.CreateElicitationResponse>>;
  layout: AcpRuntimeLayout;
  agent: Agent;
  authMethods: Array<{ id: string; name: string; description?: string }>;
  authRequired: boolean;
  authWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
};

export class AcpSessionService {
  private readonly byChat = new Map<string, LiveRuntime>();
  private readonly reapTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      agentService: AgentService;
      store: CloudAgentSessionStore;
      workspace: AgentWorkspaceService;
      workspaceFs?: ServerWorkspaceFsProvider;
    },
  ) {
    this.hooks = new AgentHooksService(deps.workspace);
    this.deviceAuth = new CodexDeviceAuth(deps.workspace);
    this.reapTimer = setInterval(() => void this.reapIdle(), 60_000);
    this.reapTimer.unref?.();
  }

  readonly deviceAuth: CodexDeviceAuth;
  private readonly hooks: AgentHooksService;
  private readonly starting = new Map<string, Promise<LiveRuntime>>();

  async prompt(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    content: string;
    parentRunId?: string | null;
  }): Promise<{ runId: string }> {
    const session = await this.deps.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    if (session.kind !== "acp") throw new Error("不是 ACP 会话");
    if (session.activeRunId) throw new Error("当前会话已有进行中的 Run，请先等待或取消");

    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    const origin = safeOrigin(session.originJson);
    const profileId = origin.acpProfileId;
    if (!profileId) throw new Error("会话未绑定 ACP profile");
    const setup = requireSetup(agent, profileId);

    const content = input.content.trim();
    if (!content) throw new Error("消息不能为空");

    const run = await this.deps.store.createRun(input.sessionId);
    const messageId = newId();
    if (session.title === "新对话") {
      const title = content.length > 40 ? `${content.slice(0, 40)}…` : content;
      await this.deps.store.updateSession(input.tenantId, input.agentId, input.sessionId, {
        title,
      });
    }
    await this.deps.store.appendEvent({
      sessionId: input.sessionId,
      type: "user_message",
      runId: run.id,
      payload: {
        messageId,
        content,
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      },
    });
    await this.deps.store.appendEvent({
      sessionId: input.sessionId,
      type: "run_start",
      runId: run.id,
      payload: { runId: run.id, replyToMessageId: messageId },
    });
    await this.deps.store.markRunStarted(run.id);

    void this.runPromptTurn({
      tenantId: input.tenantId,
      agent,
      sessionId: input.sessionId,
      runId: run.id,
      content,
      setup,
      existingAcpSessionId: origin.acpSessionId,
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const current = await this.deps.store.getRun(run.id);
        if (current && current.status !== "queued" && current.status !== "running") return;
        if (await this.deps.store.isCancelRequested(run.id)) {
          await this.finishAcpRun(input.sessionId, run.id, "cancelled");
          this.drainQueued(input.tenantId, input.agentId, input.sessionId);
          return;
        }
        await this.deps.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_error",
          runId: run.id,
          payload: { runId: run.id, message },
        });
        await this.finishAcpRun(input.sessionId, run.id, "failed", message);
        this.drainQueued(input.tenantId, input.agentId, input.sessionId);
      } catch {
        /* ignore */
      }
    });
    return { runId: run.id };
  }

  private async runPromptTurn(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    content: string;
    setup: AcpAgentSetup;
    existingAcpSessionId?: string;
  }): Promise<void> {
    const live = await this.ensureRuntime(input.agent, input.sessionId, input.setup, {
      existingAcpSessionId: input.existingAcpSessionId,
      runId: input.runId,
    });
    live.runId = input.runId;
    live.lastUsedAt = Date.now();
    live.assistantText = "";
    live.assistantMessageId = newId();
    live.thoughtMessageId = newId();
    if (!live.active) throw new Error("ACP session 未就绪");
    await emitRunStatus(this.deps.store, input.sessionId, input.runId, "thinking");
    void live.active.prompt(input.content);
    let lastStatus = "thinking";
    for (;;) {
      if (await this.deps.store.isCancelRequested(input.runId)) {
        await this.cancel(input.sessionId);
      }
      const msg = await live.active.nextUpdate();
      if (msg.kind === "stop") {
        const cancelled = msg.stopReason === "cancelled";
        if (cancelled) this.cancelPending(live);
        await this.finishAcpRun(input.sessionId, input.runId, cancelled ? "cancelled" : "completed");
        live.runId = undefined;
        live.lastUsedAt = Date.now();
        this.drainQueued(input.tenantId, input.agent.id, input.sessionId);
        return;
      }
      const side = await appendAcpUpdate(
        this.deps.store,
        input.sessionId,
        input.runId,
        msg.update as AcpSessionUpdate,
        {
          assistantMessageId: live.assistantMessageId,
          thoughtMessageId: live.thoughtMessageId,
        },
      );
      if (side.runStatus && side.runStatus !== lastStatus) {
        lastStatus = side.runStatus;
        await emitRunStatus(this.deps.store, input.sessionId, input.runId, side.runStatus);
      }
      if (side.rotateAssistant) {
        live.assistantMessageId = newId();
        live.thoughtMessageId = newId();
      }
      if (side.commands) live.availableCommands = side.commands;
      if (side.modeId) live.currentModeId = side.modeId;
      if (side.configOptions !== undefined) {
        await this.applyConfigOptions(live, side.configOptions, input.sessionId, input.runId);
      }
      if (side.sessionTitle) {
        await this.deps.store.updateSession(input.tenantId, input.agent.id, input.sessionId, {
          title: side.sessionTitle,
        });
      }
    }
  }

  private async finishAcpRun(
    sessionId: string,
    runId: string,
    status: "completed" | "cancelled" | "failed",
    error?: string,
  ): Promise<void> {
    await this.deps.store.appendEvent({
      sessionId,
      type: "run_end",
      runId,
      payload: { runId, status },
    });
    await this.deps.store.finishRun(sessionId, runId, status, error);
    const live = this.byChat.get(sessionId);
    if (live?.runId === runId) live.runId = undefined;
  }

  private drainQueued(tenantId: string, agentId: string, sessionId: string): void {
    void (async () => {
      const session = await this.deps.store.getSession(tenantId, agentId, sessionId);
      if (!session || session.activeRunId) return;
      const taken =
        (await this.deps.store.takeQueueNext(sessionId)) ??
        (await this.deps.store.takeNextQueued(sessionId));
      if (!taken?.content.trim()) return;
      try {
        await this.prompt({ tenantId, agentId, sessionId, content: taken.content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("进行中的 Run")) {
          await this.deps.store.requeueFront(sessionId, taken);
        }
      }
    })().catch(() => undefined);
  }

  async spawn(input: {
    tenantId: string;
    agent: Agent;
    profileId: string;
    task: string;
    project?: string | null;
    origin?: Record<string, unknown>;
  }): Promise<{ sessionId: string; text: string }> {
    const setup = requireSetup(input.agent, input.profileId);
    const session = await this.deps.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agent.id,
      title: `ACP · ${setup.displayName || setup.id}：${input.task.slice(0, 32)}`,
      kind: "acp",
      project: input.project ?? null,
      origin: {
        source: "agent_loop",
        runtime: "acp",
        acpProfileId: setup.id,
        ...input.origin,
      },
    });
    const { runId } = await this.prompt({
      tenantId: input.tenantId,
      agentId: input.agent.id,
      sessionId: session.id,
      content: input.task,
    });
    await waitForRun(this.deps.store, runId);
    const events = await this.deps.store.listEvents(session.id, { afterSeq: 0 });
    let text = "";
    for (const e of events) {
      const p = e.payload as { delta?: string; content?: string };
      if (e.type === "assistant_delta" && typeof p.delta === "string") text += p.delta;
      if (e.type === "assistant_message" && typeof p.content === "string") text = p.content;
    }
    return { sessionId: session.id, text };
  }

  async runtimeStatus(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<AcpRuntimeStatus> {
    const session = await this.deps.store.getSession(tenantId, agentId, sessionId);
    if (!session) throw new Error("会话不存在");
    const origin = safeOrigin(session.originJson);
    const profileId = origin.acpProfileId || "";
    let live = this.byChat.get(sessionId);
    if (!live && profileId) {
      const agent = await this.deps.agentService.get(tenantId, agentId);
      if (agent) {
        try {
          live = await this.ensureRuntime(agent, sessionId, requireSetup(agent, profileId), {
            existingAcpSessionId: origin.acpSessionId,
          });
        } catch {
          live = this.byChat.get(sessionId);
        }
      }
    }
    return {
      runtimeId: live?.id ?? "",
      sessionId,
      profileId,
      state: live ? (live.runId ? "active" : "idle") : "closed",
      acpSessionId: live?.acpSessionId ?? origin.acpSessionId,
      cwd: live?.cwd,
      models: live?.models,
      reasoning: live?.reasoning,
      modes: live?.active?.modes
        ? {
            currentId:
              live.currentModeId ||
              String((live.active.modes as { currentModeId?: string }).currentModeId ?? ""),
            available: (
              ((live.active.modes as { availableModes?: Array<{ id: string; name?: string }> })
                .availableModes ?? []) as Array<{ id: string; name?: string }>
            ).map((m) => ({ id: m.id, name: m.name || m.id })),
          }
        : live?.currentModeId
          ? { currentId: live.currentModeId, available: [] }
          : undefined,
      availableCommands: live?.availableCommands,
      authMethods: live?.authMethods,
      authRequired: live?.authRequired,
    };
  }

  async setMode(
    tenantId: string,
    agentId: string,
    sessionId: string,
    modeId: string,
  ): Promise<AcpRuntimeStatus> {
    const live = this.byChat.get(sessionId);
    if (!live?.active) throw new Error("ACP runtime 未启动");
    await live.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: live.active.sessionId,
      modeId,
    });
    live.currentModeId = modeId;
    return this.runtimeStatus(tenantId, agentId, sessionId);
  }

  async setModel(
    tenantId: string,
    agentId: string,
    sessionId: string,
    modelId: string,
  ): Promise<AcpRuntimeStatus> {
    const live = this.byChat.get(sessionId);
    if (!live?.active) throw new Error("ACP runtime 未启动");
    const configId = live.models?.configId;
    if (configId && configId !== ACP_UNSTABLE_MODEL_CONFIG_ID && !configId.startsWith("_")) {
      return this.setConfigOption(tenantId, agentId, sessionId, configId, modelId);
    }
    const params = { sessionId: live.active.sessionId, modelId };
    try {
      await live.connection.agent.request("unstable_setSessionModel", params);
    } catch {
      try {
        await live.connection.agent.request("session/set_model", params);
      } catch {
        return this.setConfigOption(tenantId, agentId, sessionId, configId || "model", modelId);
      }
    }
    if (live.models) live.models = { ...live.models, currentId: modelId };
    await this.deps.store.appendEvent({
      sessionId,
      type: "session_update",
      ...(live.runId ? { runId: live.runId } : {}),
      payload: { acpModels: live.models, acpModelId: modelId },
    });
    return this.runtimeStatus(tenantId, agentId, sessionId);
  }

  async setConfigOption(
    tenantId: string,
    agentId: string,
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<AcpRuntimeStatus> {
    const live = this.byChat.get(sessionId);
    if (!live?.active) throw new Error("ACP runtime 未启动");
    const result = await live.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: live.active.sessionId,
      configId,
      value,
    } as never);
    const options =
      result && typeof result === "object"
        ? (result as { configOptions?: unknown }).configOptions
        : undefined;
    if (options) await this.applyConfigOptions(live, options, sessionId, live.runId);
    return this.runtimeStatus(tenantId, agentId, sessionId);
  }

  async resolvePermission(
    tenantId: string,
    agentId: string,
    sessionId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean },
  ): Promise<void> {
    const live = this.byChat.get(sessionId);
    const pending = live?.permissions.get(input.requestId);
    if (!pending) throw new Error("没有等待中的授权请求");
    live!.permissions.delete(input.requestId);
    if (input.cancelled || !input.optionId) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    } else {
      pending.resolve({ outcome: { outcome: "selected", optionId: input.optionId } });
      const kind = pending.optionKinds[input.optionId];
      if (kind === "allow_always") {
        const grant = {
          kind: pending.kind || "other",
          ...(pending.pathPrefix ? { pathPrefix: pending.pathPrefix } : {}),
        };
        live!.permissionGrants = upsertAcpGrant(live!.permissionGrants, grant);
        const agent = await this.deps.agentService.get(tenantId, agentId);
        if (agent) {
          const config = readAgentAcpConfig(agent);
          await saveAgentAcpConfig(this.deps.agentService, tenantId, agent, {
            ...config,
            permissionGrants: live!.permissionGrants,
          });
        }
      }
    }
    if (live?.runId) {
      await this.deps.store.appendEvent({
        sessionId,
        type: "permission_resolved",
        runId: live.runId,
        payload: {
          requestId: input.requestId,
          outcome: input.cancelled || !input.optionId ? "cancelled" : "selected",
          optionId: input.optionId,
        },
      });
    }
  }

  async resolveElicitation(
    _tenantId: string,
    _agentId: string,
    sessionId: string,
    input: { requestId: string; cancelled?: boolean; content?: unknown },
  ): Promise<void> {
    const live = this.byChat.get(sessionId);
    const pending = live?.elicitations.get(input.requestId);
    const authLogin = Boolean(live?.authRequired && input.requestId.startsWith("auth-"));
    if (!pending && !authLogin) throw new Error("没有等待中的表单请求");
    if (pending) {
      live!.elicitations.delete(input.requestId);
      pending.resolve(
        (input.cancelled
          ? { action: "cancel" }
          : { action: "accept", content: input.content }) as acp.CreateElicitationResponse,
      );
    }
    await this.deps.store.appendEvent({
      sessionId,
      type: "elicitation_resolved",
      ...(live?.runId ? { runId: live.runId } : {}),
      payload: { requestId: input.requestId, cancelled: input.cancelled === true },
    });
    if (live?.authRequired && !input.cancelled) {
      const methodId =
        input.content && typeof input.content === "object" && !Array.isArray(input.content)
          ? String(
              (input.content as { methodId?: unknown }).methodId ?? live.authMethods[0]?.id ?? "",
            )
          : (live.authMethods[0]?.id ?? "");
      if (methodId) await this.authenticate(sessionId, methodId);
    } else if (live?.authRequired && input.cancelled) {
      settleAuthWaiters(live, new Error("已取消登录"));
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.byChat.get(sessionId);
    if (!live) return;
    this.cancelPending(live);
    if (live.active) {
      await live.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: live.active.sessionId,
      });
    }
  }

  async release(sessionId: string): Promise<void> {
    const live = this.byChat.get(sessionId);
    if (live) await this.teardown(live).catch(() => undefined);
  }

  async authenticate(sessionId: string, methodId: string): Promise<AcpRuntimeStatus> {
    const live = this.byChat.get(sessionId);
    if (!live?.connection) throw new Error("ACP runtime 未启动");
    await live.connection.agent.request(acp.methods.agent.authenticate, { methodId });
    live.authRequired = false;
    settleAuthWaiters(live);
    return this.runtimeStatus(live.agent.tenantId, live.agent.id, sessionId);
  }

  async logout(sessionId: string): Promise<void> {
    const live = this.byChat.get(sessionId);
    if (!live?.connection) return;
    await live.connection.agent.request(acp.methods.agent.logout, {}).catch(() => undefined);
    await this.teardown(live).catch(() => undefined);
  }

  async probe(
    agent: Agent,
    profileId: string,
  ): Promise<{ installed: boolean; command: string; output: string }> {
    const setup = requireSetup(agent, profileId, true);
    const profile = publicProfileForSetup(setup);
    const launch = resolveAcpLaunch(profile, setup);
    await this.deps.workspace.start(agent).catch(() => undefined);
    const result = await this.deps.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      `command -v ${shellSingle(launch.command)} && ${shellSingle(launch.command)} --version`,
    ]);
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      installed: result.exitCode === 0,
      command: [launch.command, ...launch.args].join(" "),
      output: output.slice(0, 4000),
    };
  }

  async install(
    agent: Agent,
    profileId: string,
  ): Promise<{ ok: boolean; command: string; output: string }> {
    const setup = requireSetup(agent, profileId, true);
    const profile = publicProfileForSetup(setup);
    if (profile.builtin) {
      throw new Error("内置适配器已预装在工作区镜像中，请重建镜像以更新版本");
    }
    if (!profile.installHint) throw new Error("该 profile 没有安装命令");
    if (!isSafeInstallHint(profile.installHint)) {
      throw new Error("安装命令不在允许列表内，请用 self 模式自行安装");
    }
    await this.deps.workspace.start(agent);
    const result = await this.deps.workspace.execInWorkspace(
      agent,
      ["bash", "-lc", profile.installHint],
      { timeoutMs: 180_000 },
    );
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.exitCode === 0,
      command: profile.installHint,
      output: output.slice(0, 8000),
    };
  }

  private async ensureRuntime(
    agent: Agent,
    chatSessionId: string,
    setup: AcpAgentSetup,
    opts?: { existingAcpSessionId?: string; runId?: string },
  ): Promise<LiveRuntime> {
    const inflight = this.starting.get(chatSessionId);
    if (inflight) {
      const live = await inflight;
      live.lastUsedAt = Date.now();
      if (opts?.runId) live.runId = opts.runId;
      return live;
    }
    const op = this.bootRuntime(agent, chatSessionId, setup, opts);
    this.starting.set(chatSessionId, op);
    try {
      return await op;
    } finally {
      if (this.starting.get(chatSessionId) === op) this.starting.delete(chatSessionId);
    }
  }

  private async bootRuntime(
    agent: Agent,
    chatSessionId: string,
    setup: AcpAgentSetup,
    opts?: { existingAcpSessionId?: string; runId?: string },
  ): Promise<LiveRuntime> {
    const cached = this.byChat.get(chatSessionId);
    if (cached && cached.profileId === setup.id && (cached.active || cached.authRequired)) {
      cached.lastUsedAt = Date.now();
      if (opts?.runId) cached.runId = opts.runId;
      return cached;
    }

    if (cached) {
      await this.teardown(cached).catch(() => undefined);
    }

    const session = await this.deps.store.getSession(agent.tenantId, agent.id, chatSessionId);
    const cwd = projectDefaultWorkingDir(session?.project);
    await this.deps.workspace.start(agent).catch(() => undefined);

    const profile = publicProfileForSetup(setup);
    const missing = missingRequiredAcpField(profile, setup);
    if (missing) throw new Error(`请先配置 ${profile.displayName} 的 ${missing.label}`);
    const launch = resolveAcpLaunch(profile, setup);
    const runtimeId = newId();
    const layout = acpRuntimeLayout(setup.id, setup.setupMode, runtimeId);
    try {
      await this.deps.workspace.execInWorkspace(agent, ["bash", "-lc", acpStageScript(layout)]);
      const dotenv = setup.setupMode === "api_key" ? acpApiKeyDotenv(setup.id, setup.managed) : null;
      if (dotenv) {
        const dest = `${layout.stateDir}/.env`;
        const b64 = Buffer.from(dotenv, "utf8").toString("base64");
        await this.deps.workspace.execInWorkspace(agent, [
          "bash",
          "-lc",
          `printf '%s' ${shellSingle(b64)} | base64 -d > ${shellSingle(dest)} && chmod 600 ${shellSingle(dest)}`,
        ]);
      }
    } catch (err) {
      await this.deps.workspace
        .execInWorkspace(agent, ["bash", "-lc", `rm -rf ${shellSingle(layout.runtimeDir)}`])
        .catch(() => undefined);
      throw err;
    }

    const env: Record<string, string> = { ...launch.env, ...layout.env };

    const which = await this.deps.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      `command -v ${shellSingle(launch.command)}`,
    ]);
    if (which.exitCode !== 0) {
      await this.deps.workspace
        .execInWorkspace(agent, ["bash", "-lc", `rm -rf ${shellSingle(layout.runtimeDir)}`])
        .catch(() => undefined);
      throw new Error(`工作区里找不到 ${launch.command}`);
    }

    let stdio: Awaited<ReturnType<AgentWorkspaceService["startStdio"]>>;
    try {
      stdio = await this.deps.workspace.startStdio(agent, acpStdioArgv(launch.command, launch.args), {
        workingDir: cwd,
        env,
      });
    } catch (err) {
      await this.deps.workspace
        .execInWorkspace(agent, ["bash", "-lc", `rm -rf ${shellSingle(layout.runtimeDir)}`])
        .catch(() => undefined);
      throw err;
    }

    const live: LiveRuntime = {
      id: runtimeId,
      profileId: setup.id,
      chatSessionId,
      cwd,
      extraRoots: cwd === AGENT_WORKSPACE_ROOT ? [cwd] : [cwd, AGENT_WORKSPACE_ROOT],
      kill: stdio.kill,
      connection: null as unknown as acp.ClientConnection,
      assistantText: "",
      assistantMessageId: newId(),
      thoughtMessageId: newId(),
      lastUsedAt: Date.now(),
      availableCommands: [],
      terminals: new Map(),
      permissionGrants: [],
      permissions: new Map(),
      elicitations: new Map(),
      layout,
      agent,
      authMethods: [],
      authRequired: false,
      authWaiters: [],
      ...(opts?.runId ? { runId: opts.runId } : {}),
    };

    const config = readAgentAcpConfig(agent);
    live.permissionGrants = config.permissionGrants.slice();
    const fsProvider = this.deps.workspaceFs;
    const stream = acp.ndJsonStream(stdio.writable, stdio.readable);
    const app = acp
      .client({ name: "zakura" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const requestId = String(ctx.requestId);
        const options = ctx.params.options ?? [];
        const tool = ctx.params.toolCall;
        const kind = tool?.kind ? String(tool.kind) : undefined;
        const pathPrefix = pathPrefixFromLocations(tool?.locations ?? undefined);
        if (config.permissionPolicy === "allow") {
          const allow =
            options.find((o) => String(o.kind).startsWith("allow")) ?? options[0];
          return {
            outcome: allow
              ? { outcome: "selected", optionId: allow.optionId }
              : { outcome: "cancelled" },
          };
        }
        const granted = pickGrantedOptionId(
          live.permissionGrants,
          { kind, locations: tool?.locations ?? undefined },
          options.map((o) => ({ optionId: o.optionId, kind: String(o.kind) })),
        );
        if (granted) {
          return { outcome: { outcome: "selected", optionId: granted } };
        }
        await this.deps.store.appendEvent({
          sessionId: chatSessionId,
          type: "permission_request",
          ...(live.runId ? { runId: live.runId } : {}),
          payload: {
            requestId,
            toolCallId: tool?.toolCallId ?? undefined,
            title: tool?.title ?? undefined,
            options: options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: String(o.kind),
            })),
          },
        });
        return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
          live.permissions.set(requestId, {
            resolve,
            reject,
            kind,
            pathPrefix,
            optionKinds: Object.fromEntries(options.map((o) => [o.optionId, String(o.kind)])),
          });
        });
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        if (!fsProvider) throw new Error("workspace fs unavailable");
        const path = assertAcpFsPath(ctx.params.path, live);
        const fs = await fsProvider.forAgent(agent.id, agent.tenantId);
        const read = await fs.readText(path);
        let content = read.content;
        if (ctx.params.line && ctx.params.line > 1) {
          const lines = content.split("\n");
          content = lines.slice(ctx.params.line - 1).join("\n");
        }
        if (ctx.params.limit && ctx.params.limit > 0) {
          content = content.split("\n").slice(0, ctx.params.limit).join("\n");
        }
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        if (!fsProvider) throw new Error("workspace fs unavailable");
        const path = assertAcpFsPath(ctx.params.path, live);
        const denied = firstDeny(
          await this.hooks.runEvent(agent, "PreToolUse", {
            toolName: "write_text_file",
            toolArgs: { path, content: ctx.params.content },
            workingDir: live.cwd,
            sessionId: chatSessionId,
          }),
        );
        if (denied) throw new Error(denied.reason || "hook 拒绝写入");
        const fs = await fsProvider.forAgent(agent.id, agent.tenantId);
        await fs.writeText(path, ctx.params.content);
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, async (ctx) => {
        const cwd = ctx.params.cwd || live.cwd;
        if (cwd) assertAcpFsPath(cwd, live);
        const args = ctx.params.args ?? [];
        const command = args.length
          ? [ctx.params.command, ...args]
          : ["bash", "-lc", ctx.params.command];
        const env: Record<string, string> = {};
        for (const item of ctx.params.env ?? []) {
          if (item.name) env[item.name] = item.value ?? "";
        }
        const result = await this.deps.workspace.startShellJob(agent, command, {
          workingDir: cwd || live.cwd,
          ...(Object.keys(env).length ? { env } : {}),
        });
        live.terminals.set(result.jobId, {
          outputByteLimit: ctx.params.outputByteLimit ?? undefined,
        });
        return { terminalId: result.jobId };
      })
      .onRequest(acp.methods.client.terminal.output, async (ctx) => {
        const snap = await this.deps.workspace.getShellJob(agent, ctx.params.terminalId);
        const limit = live.terminals.get(ctx.params.terminalId)?.outputByteLimit;
        const clipped = clipAcpTerminalOutput(`${snap.stdout}${snap.stderr}`, limit);
        return {
          output: clipped.output,
          truncated: clipped.truncated,
          exitStatus: snap.running ? null : { exitCode: snap.exitCode ?? 0, signal: null },
        };
      })
      .onRequest(acp.methods.client.terminal.release, async (ctx) => {
        live.terminals.delete(ctx.params.terminalId);
        await this.deps.workspace.killShellJob(agent, ctx.params.terminalId).catch(() => undefined);
        return {};
      })
      .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
        const snap = await this.deps.workspace.waitShellJob(agent, ctx.params.terminalId, 120_000);
        return { exitCode: snap.exitCode ?? 0, signal: null };
      })
      .onRequest(acp.methods.client.terminal.kill, async (ctx) => {
        live.terminals.delete(ctx.params.terminalId);
        await this.deps.workspace.killShellJob(agent, ctx.params.terminalId);
        return {};
      })
      .onRequest(acp.methods.client.elicitation.create, async (ctx) => {
        const requestId = String(ctx.requestId);
        await this.deps.store.appendEvent({
          sessionId: chatSessionId,
          type: "elicitation_request",
          ...(live.runId ? { runId: live.runId } : {}),
          payload: {
            requestId,
            mode: ctx.params.mode === "url" ? "url" : "form",
            message: typeof ctx.params.message === "string" ? ctx.params.message : undefined,
            url:
              typeof (ctx.params as { url?: unknown }).url === "string"
                ? (ctx.params as { url: string }).url
                : undefined,
            fields: elicitationFields(ctx.params),
          },
        });
        return new Promise((resolve, reject) => {
          live.elicitations.set(requestId, { resolve, reject });
        });
      });

    live.connection = app.connect(stream);
    this.byChat.set(chatSessionId, live);
    try {
      const init = await live.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          elicitation: { form: {}, url: {} },
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "zakura", title: "Zakura", version: "0.1.0" },
      });
      live.authMethods = (init.authMethods ?? []).map((m) => ({
        id: String(m.id),
        name: String(m.name || m.id),
        ...(typeof m.description === "string" && m.description
          ? { description: m.description }
          : {}),
      }));

      const mcpServers =
        init.agentCapabilities?.mcpCapabilities?.http || profile.forceHttpMcp
          ? await listHttpMcpServers(this.deps.agentService, agent.id)
          : [];
      const additionalDirectories =
        cwd !== AGENT_WORKSPACE_ROOT ? [AGENT_WORKSPACE_ROOT] : undefined;
      const existingAcpSessionId = opts?.existingAcpSessionId;

      const openSession = async () => {
        if (existingAcpSessionId && init.agentCapabilities?.loadSession) {
          try {
            const loaded = await live.connection.agent.request(acp.methods.agent.session.load, {
              sessionId: existingAcpSessionId,
              cwd,
              mcpServers,
              ...(additionalDirectories ? { additionalDirectories } : {}),
            });
            live.active = attachLoadedSession(live.connection.agent, existingAcpSessionId, loaded);
            live.acpSessionId = existingAcpSessionId;
            return;
          } catch (err) {
            if (isAuthRequiredError(err)) throw err;
          }
        }
        live.active = await startAcpSession(
          live.connection.agent,
          cwd,
          mcpServers,
          additionalDirectories,
        );
        live.acpSessionId = live.active.sessionId;
      };

      try {
        await openSession();
      } catch (err) {
        if (!isAuthRequiredError(err)) throw err;
        live.authRequired = true;
        await emitAuthElicitation(this.deps.store, live);
        await waitForAuth(live);
        live.authRequired = false;
        await openSession();
      }

      const modeId = profile.sessionModeId;
      if (modeId && live.active) {
        await live.connection.agent
          .request(acp.methods.agent.session.setMode, {
            sessionId: live.active.sessionId,
            modeId,
          })
          .catch(() => undefined);
        live.currentModeId = modeId;
      }

      if (live.active) {
        await this.applyConfigOptions(
          live,
          live.active.newSessionResponse,
          chatSessionId,
          opts?.runId,
        );
      }

      await this.deps.store.updateSession(agent.tenantId, agent.id, chatSessionId, {
        origin: {
          ...safeOrigin(session?.originJson ?? "{}"),
          runtime: "acp",
          acpProfileId: setup.id,
          acpSessionId: live.acpSessionId,
          acpRuntimeId: live.id,
        },
      });

      void live.connection.closed.then(() => {
        if (this.byChat.get(chatSessionId) === live) this.byChat.delete(chatSessionId);
      });
      return live;
    } catch (err) {
      await this.teardown(live).catch(() => undefined);
      await this.deps.workspace
        .execInWorkspace(agent, ["bash", "-lc", `rm -rf ${shellSingle(layout.runtimeDir)}`])
        .catch(() => undefined);
      throw err;
    }
  }

  private cancelPending(live: LiveRuntime) {
    settleAll(live.permissions, { outcome: { outcome: "cancelled" } });
    settleAll(live.elicitations, { action: "cancel" } as acp.CreateElicitationResponse);
    settleAuthWaiters(live, new Error("ACP runtime 已关闭"));
  }

  private async applyConfigOptions(
    live: LiveRuntime,
    raw: unknown,
    sessionId: string,
    runId?: string,
  ): Promise<void> {
    const parsed = parseAcpSessionModelState(raw);
    if (parsed.models) live.models = parsed.models;
    if (parsed.reasoning) live.reasoning = parsed.reasoning;
    if (!parsed.models && !parsed.reasoning) return;
    await this.deps.store.appendEvent({
      sessionId,
      type: "session_update",
      ...(runId ? { runId } : {}),
      payload: {
        ...(parsed.models ? { acpModels: parsed.models } : {}),
        ...(parsed.reasoning ? { acpReasoning: parsed.reasoning } : {}),
      },
    });
  }

  private async teardown(live: LiveRuntime): Promise<void> {
    this.cancelPending(live);
    if (live.active) {
      await live.connection.agent
        .request(acp.methods.agent.session.close, { sessionId: live.active.sessionId })
        .catch(() => undefined);
      live.active.dispose();
    }
    await live.kill().catch(() => undefined);
    await this.deps.workspace
      .execInWorkspace(live.agent, ["bash", "-lc", acpSyncBackScript(live.layout)])
      .catch(() => undefined);
    this.byChat.delete(live.chatSessionId);
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const live of [...this.byChat.values()]) {
      if (shouldReapAcpRuntime(live, now)) await this.teardown(live).catch(() => undefined);
    }
  }
}

function requireSetup(agent: Agent, profileId: string, allowDisabled = false): AcpAgentSetup {
  const config = readAgentAcpConfig(agent);
  const existing = config.agents[profileId];
  if (existing && (existing.enabled || allowDisabled)) return existing;
  if (allowDisabled) {
    const builtin = publicProfileForSetup({
      id: profileId,
      enabled: false,
      setupMode: "self",
      managed: {},
    });
    return {
      id: builtin.id,
      enabled: false,
      setupMode: "self",
      command: builtin.command,
      args: builtin.args,
      managed: {},
    };
  }
  const enabled = listEnabledAcpSetups(config);
  throw new Error(
    enabled.length
      ? `ACP agent「${profileId}」未启用`
      : "尚未启用任何 ACP agent，请到 Agent 设置里配置",
  );
}

function safeOrigin(raw: string): {
  acpProfileId?: string;
  acpSessionId?: string;
  acpRuntimeId?: string;
} {
  try {
    const o = JSON.parse(raw || "{}") as Record<string, unknown>;
    return {
      acpProfileId: typeof o.acpProfileId === "string" ? o.acpProfileId : undefined,
      acpSessionId: typeof o.acpSessionId === "string" ? o.acpSessionId : undefined,
      acpRuntimeId: typeof o.acpRuntimeId === "string" ? o.acpRuntimeId : undefined,
    };
  } catch {
    return {};
  }
}

function shellSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSafeInstallHint(hint: string): boolean {
  const t = hint.trim();
  if (/^npm i(nstall)? -g @?[a-z0-9][a-z0-9._/@-]*$/i.test(t)) return true;
  if (/^pip3? install( --break-system-packages)? hermes-agent(\[acp\])?$/i.test(t)) return true;
  return false;
}

/** ACP 要求超限时从头部丢掉，并落在字符边界上。 */
function clipAcpTerminalOutput(
  output: string,
  limit?: number,
): { output: string; truncated: boolean } {
  if (!limit || limit <= 0) return { output, truncated: false };
  const buf = Buffer.from(output);
  if (buf.length <= limit) return { output, truncated: false };
  let start = buf.length - limit;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return { output: buf.subarray(start).toString("utf8"), truncated: true };
}

function assertAcpFsPath(path: string, live: LiveRuntime): string {
  const p = path.replace(/\\/g, "/");
  if (!isPathUnderRoots(p, live.extraRoots.length ? live.extraRoots : [live.cwd])) {
    throw new Error(`路径超出会话工作区: ${path}`);
  }
  return p;
}

function elicitationFields(
  params: unknown,
): Array<{ id: string; type: string; title?: string; required?: boolean }> | undefined {
  const rec = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const schema =
    rec.requestedSchema && typeof rec.requestedSchema === "object"
      ? (rec.requestedSchema as Record<string, unknown>)
      : null;
  const props =
    schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (!props) return undefined;
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [],
  );
  const fields = Object.entries(props)
    .slice(0, 16)
    .map(([id, raw]) => {
      const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        id,
        type: typeof p.type === "string" ? p.type : "string",
        title:
          typeof p.title === "string"
            ? p.title
            : typeof p.description === "string"
              ? p.description
              : id,
        required: required.has(id),
      };
    });
  return fields.length ? fields : undefined;
}

async function listHttpMcpServers(
  agentService: AgentService,
  agentId: string,
): Promise<acp.McpServer[]> {
  const bindings = await agentService.listBindings(agentId);
  const out: acp.McpServer[] = [];
  for (const b of bindings) {
    const url = b.endpointUrl?.trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({
      type: "http",
      name: b.instanceSlug || b.instanceName,
      url,
      headers: [],
    });
  }
  return out;
}

async function startAcpSession(
  agent: acp.ClientContext,
  cwd: string,
  mcpServers: acp.McpServer[],
  additionalDirectories?: string[],
): Promise<acp.ActiveSession> {
  let builder = agent.buildSession({ cwd, mcpServers });
  if (additionalDirectories?.length) {
    builder = builder.withAdditionalDirectories(additionalDirectories);
  }
  return builder.start();
}

function attachLoadedSession(
  agent: acp.ClientContext,
  sessionId: string,
  loaded: unknown,
): acp.ActiveSession {
  const extra = loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : {};
  return (
    agent as unknown as {
      attachSession: (r: { sessionId: string } & Record<string, unknown>) => acp.ActiveSession;
    }
  ).attachSession({ sessionId, ...extra });
}

export function isAuthRequiredError(err: unknown): boolean {
  const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const data = rec?.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : null;
  if (data && (data.code === "auth_required" || data.error === "auth_required")) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /auth[_ ]?required/i.test(msg);
}

function settleAuthWaiters(live: LiveRuntime, err?: Error) {
  const waiters = live.authWaiters.splice(0);
  for (const w of waiters) {
    if (err) w.reject(err);
    else w.resolve();
  }
}

function waitForAuth(live: LiveRuntime): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      live.authRequired = false;
      reject(new Error("ACP 登录超时"));
    }, 15 * 60 * 1000);
    live.authWaiters.push({
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

async function emitAuthElicitation(store: CloudAgentSessionStore, live: LiveRuntime) {
  const requestId = `auth-${live.id}`;
  const methods = live.authMethods;
  await store.appendEvent({
    sessionId: live.chatSessionId,
    type: "elicitation_request",
    ...(live.runId ? { runId: live.runId } : {}),
    payload: {
      requestId,
      mode: "form",
      message: methods.length
        ? `需要登录 ${live.profileId}。提交 methodId：${methods.map((m) => m.id).join(" / ")}`
        : `需要登录 ${live.profileId}`,
      fields: [
        {
          id: "methodId",
          type: "string",
          title: "登录方式",
          required: true,
        },
      ],
    },
  });
}

async function emitRunStatus(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  status: "thinking" | "streaming" | "tool",
): Promise<void> {
  await store.appendEvent({
    sessionId,
    type: "run_status",
    runId,
    payload: { runId, status },
  });
}

async function waitForRun(store: CloudAgentSessionStore, runId: string): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("ACP 任务超时");
}
