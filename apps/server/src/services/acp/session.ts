/**
 * ACP 会话：在 workspace 容器里拉起第三方 Agent，把协议事件写入 Cloud 会话。
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_WORKSPACE_ROOT,
  acpApiKeyDotenv,
  acpGeneratedRuntimeFiles,
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
  parseCloudAgentConfig,
  ACP_UNSTABLE_MODEL_CONFIG_ID,
  publicProfileForSetup,
  resolveAcpLaunch,
  upsertAcpGrant,
  type AcpAgentSetup,
  type AcpPermissionGrant,
  type AcpRuntimeLayout,
  type AcpRuntimeState,
  type AcpRuntimeStatus,
} from "@zakura/shared";
/** Zakura 路由下可用的网关模型别名；失败返回 undefined，由调用方回退。 */
async function fetchAcpGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(body.data)
      ? body.data
          .map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
          .filter(Boolean)
      : [];
    return ids.length ? ids.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}
import { newId } from "../../db/schema.js";
import type { Agent } from "../../db/schema.js";
import type { AgentService } from "../agents.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import { AgentHooksService, firstDeny } from "../agent-hooks.js";
import {
  provisionAcpZakuraRoutes,
  readAgentAcpConfig,
  saveAgentAcpConfig,
} from "./config.js";
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
  /** Zakura 路由：模型目录与切换都以网关别名表达 */
  zakuraRouted: boolean;
  gatewayModels?: string[];
  authMethods: Array<{ id: string; name: string; description?: string }>;
  authRequired: boolean;
  authWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
};

/** prompt() 拒绝并发回合时使用；drainQueued 按此常量识别「已被新回合抢占」。 */
const RUN_BUSY_MESSAGE = "当前会话已有进行中的 Run，请先等待或取消";
const DRAFT_BOOT_TIMEOUT_MS = 90_000;

export class AcpSessionService {
  private readonly byChat = new Map<string, LiveRuntime>();
  /** 使超时/切换后的迟到启动结果失效 */
  private readonly draftEpoch = new Map<string, number>();
  private readonly reapTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      agentService: AgentService;
      store: CloudAgentSessionStore;
      workspace: AgentWorkspaceService;
      workspaceFs?: ServerWorkspaceFsProvider;
      publicBaseUrl?: string;
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

  /** 立刻落库草稿，initialize / session/new 在后台跑；失败走 session_update.acpError。 */
  async prepareDraft(input: {
    tenantId: string;
    agentId: string;
    profileId: string;
    project?: string | null;
  }) {
    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");
    const setup = requireSetup(agent, input.profileId);
    const session = await this.deps.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agentId,
      title: `ACP · ${setup.displayName || setup.id}`,
      kind: "acp",
      project: input.project ?? null,
      origin: { runtime: "acp", acpProfileId: setup.id },
    });
    void this.startDraftRuntime(agent, session.id, setup);
    return {
      session,
      runtime: {
        runtimeId: "",
        sessionId: session.id,
        profileId: setup.id,
        state: "starting",
      },
    };
  }

  private async startDraftRuntime(agent: Agent, sessionId: string, setup: AcpAgentSetup) {
    const epoch = (this.draftEpoch.get(sessionId) ?? 0) + 1;
    this.draftEpoch.set(sessionId, epoch);
    const boot = this.ensureRuntime(agent, sessionId, setup);
    boot.catch(() => undefined);
    try {
      const live = await Promise.race([
        boot,
        sleep(DRAFT_BOOT_TIMEOUT_MS).then(() => {
          throw new Error("Agent 启动超时");
        }),
      ]);
      if (this.draftEpoch.get(sessionId) !== epoch) return;
      await this.emitRuntimeSnapshot(sessionId, live);
    } catch (err) {
      if (this.draftEpoch.get(sessionId) !== epoch) return;
      this.draftEpoch.set(sessionId, epoch + 1);
      const live = this.byChat.get(sessionId);
      if (live) await this.teardown(live).catch(() => undefined);
      const message = describeAcpRpcError(err).message;
      await this.deps.store
        .appendEvent({
          sessionId,
          type: "session_update",
          payload: { acpState: "closed", acpError: message },
        })
        .catch(() => undefined);
    }
  }

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
    if (session.activeRunId) throw new Error(RUN_BUSY_MESSAGE);

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
    live.assistantMessageId = newId();
    live.thoughtMessageId = newId();
    if (!live.active) throw new Error("ACP session 未就绪");
    const active = live.active;
    await emitRunStatus(this.deps.store, input.sessionId, input.runId, "thinking");

    // prompt() 的 JSON-RPC 错误不能丢：适配器若在发出任何 update 前就报错
    // （凭证无效、会话损坏），下一个 nextUpdate 永远不会 resolve，run 会
    // 永久停在 running。这里把 rejection 记下来，由 tick 分支转成 run_error。
    let promptFailed: unknown = null;
    let promptSettledAt: number | null = null;
    void active.prompt(input.content).then(
      () => {
        promptSettledAt = Date.now();
      },
      (err) => {
        promptSettledAt = Date.now();
        promptFailed = err;
      },
    );

    let updateP = active.nextUpdate();
    // race 输掉的分支依然可能 reject；先挂一个兜底避免 unhandledRejection。
    updateP.catch(() => {});
    const TICK = Symbol("tick");
    const CLOSED = Symbol("closed");
    const closedP = live.connection.closed.then(
      () => CLOSED,
      () => CLOSED,
    );
    let lastStatus = "thinking";
    let lastCancelCheck = 0;
    for (;;) {
      const winner = await Promise.race([
        updateP,
        closedP,
        new Promise<typeof TICK>((resolve) => setTimeout(() => resolve(TICK), 250)),
      ]);
      if (winner === CLOSED) {
        throw new Error("ACP Agent 进程意外退出");
      }
      if (winner === TICK) {
        const now = Date.now();
        if (promptFailed !== null) throw promptFailed;
        // 无 update 时也要及时响应取消：session/cancel 只能在间隙发出。
        if (now - lastCancelCheck >= 500) {
          lastCancelCheck = now;
          if (await this.deps.store.isCancelRequested(input.runId)) {
            await this.cancel(input.sessionId);
          }
        }
        // 正常顺序下 stop 通知先于 prompt 响应（同一条 FIFO 流）；
        // 若适配器只回了响应没发 stop，宽限后按完成收尾，避免挂起。
        if (promptSettledAt !== null && now - promptSettledAt > 2500) {
          await this.finishAcpRun(input.sessionId, input.runId, "completed");
          live.runId = undefined;
          live.lastUsedAt = Date.now();
          this.drainQueued(input.tenantId, input.agent.id, input.sessionId);
          return;
        }
        continue;
      }
      const msg = winner as Awaited<ReturnType<typeof active.nextUpdate>>;
      updateP = active.nextUpdate();
      updateP.catch(() => {});
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
        if (message === RUN_BUSY_MESSAGE) {
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
    return this.snapshotRuntime(sessionId, origin.acpProfileId || "", origin);
  }

  private snapshotRuntime(
    sessionId: string,
    profileId: string,
    origin: { acpSessionId?: string },
  ): AcpRuntimeStatus {
    const live = this.byChat.get(sessionId);
    const starting = this.starting.has(sessionId);
    return {
      runtimeId: live?.id ?? "",
      sessionId,
      profileId,
      state: acpSnapshotState({
        hasLive: Boolean(live),
        runActive: Boolean(live?.runId),
        starting,
        authRequired: Boolean(live?.authRequired),
        sessionOpen: Boolean(live?.active),
      }),
      acpSessionId: live?.acpSessionId ?? origin.acpSessionId,
      cwd: live?.cwd,
      models: live?.models,
      reasoning: live?.reasoning,
      modes: snapshotModes(live),
      availableCommands: live?.availableCommands,
      authMethods: live?.authMethods,
      authRequired: live?.authRequired,
    };
  }

  private async emitRuntimeSnapshot(sessionId: string, live: LiveRuntime): Promise<void> {
    const modes = snapshotModes(live);
    await this.deps.store.appendEvent({
      sessionId,
      type: "session_update",
      ...(live.runId ? { runId: live.runId } : {}),
      payload: {
        acpState: live.runId ? "active" : "idle",
        ...(live.availableCommands.length ? { acpCommands: live.availableCommands } : {}),
        ...(live.models ? { acpModels: live.models } : {}),
        ...(live.reasoning ? { acpReasoning: live.reasoning } : {}),
        ...(modes
          ? { acpModes: modes, ...(modes.currentId ? { acpModeId: modes.currentId } : {}) }
          : {}),
      },
    });
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
    if (live.runId) throw new Error("当前 ACP 任务运行中，完成后再切换模型");
    await this.deps.store.updateSession(tenantId, agentId, sessionId, { model: modelId });
    const configId = dynamicModelConfigId(live);
    if (!configId) {
      // Some ACP adapters expose a model list but no standard runtime setter
      // (notably Codex and several community adapters). Restarting an idle
      // draft runtime is the only way to apply the selected startup model.
      const agent = await this.deps.agentService.get(tenantId, agentId);
      if (!agent) throw new Error("Agent 不存在");
      const setup = requireSetup(agent, live.profileId);
      // 保留 ACP 侧会话：不下发 session/close，重启后走 session/load 恢复
      // 上下文（Codex/OpenCode 等把会话持久化在自己的 state 目录里）。
      const previousAcpSessionId = live.acpSessionId;
      await this.teardown(live, { keepSession: true });
      await this.ensureRuntime(agent, sessionId, setup, {
        existingAcpSessionId: previousAcpSessionId,
      });
      return this.runtimeStatus(tenantId, agentId, sessionId);
    }
    // setConfigOption 的取值用适配器协议 id（OpenCode 需要 zakura/ 前缀）；
    // 展示与持久化始终用网关裸别名。
    return this.setConfigOption(
      tenantId,
      agentId,
      sessionId,
      configId,
      acpModelProtocolId(live, modelId),
    );
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
    const payload =
      typeof value === "boolean"
        ? { sessionId: live.active.sessionId, configId, value, type: "boolean" as const }
        : { sessionId: live.active.sessionId, configId, value };
    const result = await live.connection.agent.request(acp.methods.agent.session.setConfigOption, payload);
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
    this.draftEpoch.set(sessionId, (this.draftEpoch.get(sessionId) ?? 0) + 1);
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

    // Repair legacy Zakura ACP profiles at the point of use as well as in the
    // settings route. This closes the path where a user starts chat directly
    // with an old profile that has no persisted Gateway key yet.
    if (setup.modelProvider === "zakura" && this.deps.publicBaseUrl) {
      const provisioned = await provisionAcpZakuraRoutes(
        this.deps.agentService,
        agent.tenantId,
        agent,
        readAgentAcpConfig(agent),
        this.deps.publicBaseUrl,
      );
      setup = provisioned.agents[setup.id] ?? setup;
    }
    if (setup.modelProvider === "zakura" && !setup.managed.zakura_api_key?.trim()) {
      throw new Error("Zakura 路由缺少 Agent Gateway API key，请重新保存 ACP 配置");
    }

    // Model selection made before the first prompt is stored on the chat
    // session. Overlay it onto this launch only: it must not mutate the
    // Agent-wide ACP profile, and it lets every adapter receive its own
    // environment/startup model before session/new.
    const launchSetup = withSessionModel(setup, session?.model);
    const profile = publicProfileForSetup(launchSetup);
    const missing = missingRequiredAcpField(profile, launchSetup);
    if (missing) throw new Error(`请先配置 ${profile.displayName} 的 ${missing.label}`);
    const launch = resolveAcpLaunch(profile, launchSetup);
    const runtimeId = newId();
    // A Zakura route is API-key based even when the profile was previously
    // saved as `self`. Do not stage the user's old OAuth/login home into this
    // process: Kimi (and similar CLIs) inspect that state before environment
    // variables and otherwise return `Authentication required`.
    const runtimeSetupMode = setup.modelProvider === "zakura" ? "api_key" : setup.setupMode;
    const layout = acpRuntimeLayout(setup.id, runtimeSetupMode, runtimeId);
    // OpenCode/Codex 需要真正的配置文件（自定义 provider / base URL 不能
    // 只靠 env 传递）。所有走 Zakura 路由的 profile 都拉取网关模型别名：
    // 一是填充启动配置，二是运行时覆盖适配器自己公告的模型目录——
    // codex/pi 等公告的内置模型在网关侧都是无效别名。
    const gatewayModels =
      launchSetup.modelProvider === "zakura" &&
      launchSetup.managed.zakura_base_url?.trim() &&
      launchSetup.managed.zakura_api_key?.trim()
        ? await fetchAcpGatewayModels(
            launchSetup.managed.zakura_base_url!,
            launchSetup.managed.zakura_api_key!,
          )
        : undefined;
    // 未显式选模型时优先沿用 Agent 的 Zakura 默认 chat 模型，
    // 避免落到网关列表里排最前的免费模型。
    let preferredModel: string | undefined;
    try {
      preferredModel =
        parseCloudAgentConfig(JSON.parse(agent.configJson || "{}")).model?.trim() || undefined;
    } catch {
      preferredModel = undefined;
    }
    try {
      await this.deps.workspace.execInWorkspace(agent, ["bash", "-lc", acpStageScript(layout)]);
      // Hermes loads `$HOME/.env` before it builds its provider client.  A
      // Zakura route is commonly configured as `self` (the route supplies the
      // credential), so gating this only on api_key silently dropped the
      // Gateway token and produced HTTP 401 Missing Authentication header.
      const dotenv =
        launchSetup.id === "hermes" &&
        (launchSetup.setupMode === "api_key" || launchSetup.modelProvider === "zakura")
          ? acpApiKeyDotenv(launchSetup.id, launchSetup.managed)
          : null;
      const generated = acpGeneratedRuntimeFiles({
        layout,
        keyMode: runtimeSetupMode,
        routed: launchSetup.modelProvider === "zakura",
        managed: launchSetup.managed,
        gatewayModels,
        preferredModel,
      });
      const writes = [
        ...(dotenv
          ? [{
              dest: `${layout.env.HERMES_HOME || layout.stateDir}/.env`,
              content: dotenv,
            }]
          : []),
        ...generated,
      ];
      if (writes.length) {
        const script = writes
          .map((w) => {
            const b64 = Buffer.from(w.content, "utf8").toString("base64");
            return `mkdir -p ${shellSingle(dirnameSh(w.dest))} && printf '%s' ${shellSingle(b64)} | base64 -d > ${shellSingle(w.dest)} && chmod 600 ${shellSingle(w.dest)}`;
          })
          .join(" && ");
        await this.deps.workspace.execInWorkspace(agent, ["bash", "-lc", script]);
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
      zakuraRouted: launchSetup.modelProvider === "zakura",
      ...(gatewayModels?.length ? { gatewayModels } : {}),
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
        if (snap.running) {
          // 命令仍在运行却返回 exitCode 会把失败伪装成成功，agent 会基于
          // 假结果继续；报错让 agent 自行决定等待或终止。
          throw new Error("terminal command still running after timeout");
        }
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
        // Zakura 路由下适配器公告的模型目录（codex 内置 gpt 系列、pi 自家
        // 目录等）对网关无效——选了也只会以未知别名打到网关。统一改挂
        // 网关模型别名，聊天框的模型列表与切换就都指向 Zakura。
        if (live.zakuraRouted && gatewayModels?.length) {
          const announced = live.models?.currentId?.replace(/^zakura\//, "");
          const configured = launchSetup.managed.model?.trim();
          const current =
            (announced && gatewayModels.includes(announced) ? announced : undefined) ??
            (configured && gatewayModels.includes(configured) ? configured : undefined) ??
            (preferredModel && gatewayModels.includes(preferredModel) ? preferredModel : undefined) ??
            gatewayModels[0]!;
          live.models = {
            currentId: current,
            available: gatewayModels.map((id) => ({ id, name: id })),
            configId: live.models?.configId,
          };
          await this.deps.store.appendEvent({
            sessionId: chatSessionId,
            type: "session_update",
            ...(opts?.runId ? { runId: opts.runId } : {}),
            payload: { acpModels: live.models },
          });
        }
        // Apply the configured model before the first prompt.  ACP exposes
        // model selection only after session/new, so waiting for the chat
        // toolbar would otherwise make the first turn run on the adapter's
        // implicit default.
        const preferredModelId =
          launchSetup.managed.model?.trim() || gatewayModels?.[0];
        if (preferredModelId) {
          await this.applyPreferredModel(live, preferredModelId);
        }
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

  private async applyPreferredModel(live: LiveRuntime, modelId: string): Promise<void> {
    const configId = dynamicModelConfigId(live);
    // Do not probe undocumented JSON-RPC extensions here.  Codex rejects
    // them with `Invalid params`; launch env is the compatible path for ACP
    // implementations that do not expose a selectable config option.
    if (!configId) return;
    try {
      await live.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: live.active!.sessionId,
        configId,
        value: acpModelProtocolId(live, modelId),
      });
      if (live.models) live.models = { ...live.models, currentId: modelId };
    } catch (err) {
      console.warn("[acp] initial model config rejected", {
        profileId: live.profileId,
        method: acp.methods.agent.session.setConfigOption,
        configId,
        error: describeAcpRpcError(err),
      });
    }
  }

  private async teardown(live: LiveRuntime, opts?: { keepSession?: boolean }): Promise<void> {
    this.cancelPending(live);
    if (live.active && !opts?.keepSession) {
      await live.connection.agent
        .request(acp.methods.agent.session.close, { sessionId: live.active.sessionId })
        .catch(() => undefined);
    }
    live.active?.dispose();
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

/** Only a config option announced by session/new is safe to set at runtime. */
function dynamicModelConfigId(live: LiveRuntime): string | undefined {
  const configId = live.models?.configId;
  return configId && configId !== ACP_UNSTABLE_MODEL_CONFIG_ID && !configId.startsWith("_")
    ? configId
    : undefined;
}

/**
 * ACP 模型取值的协议 id：内部与网关别名一律用裸名；只有 OpenCode 的
 * 模型 id 是 provider/model 形式，Zakura 路由下要挂 zakura/ 前缀。
 */
function acpModelProtocolId(live: LiveRuntime, modelId: string): string {
  return live.zakuraRouted && live.profileId === "opencode" ? `zakura/${modelId}` : modelId;
}

/** Apply a one-session model override without changing the persisted ACP profile. */
function withSessionModel(setup: AcpAgentSetup, model: string | null | undefined): AcpAgentSetup {
  // 旧会话可能存过带 zakura/ 前缀的 id（OpenCode 公告值直写）；剥掉前缀，
  // 否则配置生成会叠出 zakura/zakura/xxx。
  const value = model?.trim().replace(/^zakura\//, "");
  if (!value) return setup;
  return { ...setup, managed: { ...setup.managed, model: value } };
}

export function acpSnapshotState(input: {
  hasLive: boolean;
  runActive: boolean;
  starting: boolean;
  authRequired?: boolean;
  sessionOpen?: boolean;
}): AcpRuntimeState {
  if (input.hasLive) {
    if (input.runActive) return "active";
    if (input.authRequired || !input.sessionOpen) return "starting";
    return "idle";
  }
  return input.starting ? "starting" : "closed";
}

function snapshotModes(live?: LiveRuntime): AcpRuntimeStatus["modes"] {
  if (!live) return undefined;
  if (live.active?.modes) {
    const modes = live.active.modes as {
      currentModeId?: string;
      availableModes?: Array<{ id: string; name?: string }>;
    };
    return {
      currentId: live.currentModeId || String(modes.currentModeId ?? ""),
      available: (modes.availableModes ?? []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
      })),
    };
  }
  if (live.currentModeId) return { currentId: live.currentModeId, available: [] };
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON-RPC errors can contain credentials in arbitrary data; log only stable diagnostics. */
function describeAcpRpcError(err: unknown): { message: string; code?: unknown } {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  return {
    message: err instanceof Error ? err.message : String(err),
    ...(record && "code" in record ? { code: record.code } : {}),
  };
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

function dirnameSh(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
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
): Array<{
  id: string;
  type: string;
  title?: string;
  required?: boolean;
  options?: string[];
}> | undefined {
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
      // JSON Schema 的 enum（如选择登录方式）原样透传，前端渲染为下拉。
      const options = Array.isArray(p.enum)
        ? p.enum.filter((v): v is string => typeof v === "string" && v.length > 0)
        : undefined;
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
        ...(options?.length ? { options } : {}),
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
        ? `需要登录 ${live.profileId}，请选择登录方式：${methods.map((m) => m.name || m.id).join(" / ")}`
        : `需要登录 ${live.profileId}`,
      fields: [
        {
          id: "methodId",
          type: "string",
          title: "登录方式",
          required: true,
          // enum 让前端渲染成下拉，避免用户手填内部 methodId。
          ...(methods.length ? { options: methods.map((m) => m.id) } : {}),
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
