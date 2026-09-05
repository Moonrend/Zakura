/**
 * ACP 会话：在 workspace 容器里拉起第三方 Agent，把协议事件写入 Cloud 会话。
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_WORKSPACE_ROOT,
  acpApiKeyDotenv,
  acpAdapterSource,
  acpGeneratedRuntimeFiles,
  acpRuntimeLayout,
  acpCommandResolveExpr,
  acpStageScript,
  acpStdioArgv,
  acpSyncBackScript,
  listEnabledAcpSetups,
  missingRequiredAcpField,
  projectDefaultWorkingDir,
  parseAcpSessionModelState,
  parseCloudAgentConfig,
  planAcpPromptBlocks,
  ACP_UNSTABLE_MODEL_CONFIG_ID,
  acpRegistryIdForProfile,
  publicProfileForSetup,
  resolveAcpLaunch,
  upsertAcpGrant,
  type AcpAgentSetup,
  type AcpGatewayModel,
  type AcpPermissionGrant,
  type AcpPromptBlockPlanItem,
  type AcpPromptCapabilities,
  type AcpRuntimeLayout,
  type AcpRuntimeState,
  type AcpRuntimeStatus,
  type CloudAgentAttachment,
} from "@zakura/shared";
/** Zakura 路由下可用的网关模型别名（带元数据）；失败返回 undefined，由调用方回退。 */
async function fetchAcpGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<AcpGatewayModel[] | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      data?: Array<{
        id?: unknown;
        name?: unknown;
        metadata?: Record<string, unknown> | null;
      }>;
    };
    const items = Array.isArray(body.data)
      ? body.data
          .map((m): AcpGatewayModel | null => {
            const id = typeof m?.id === "string" ? m.id.trim() : "";
            if (!id) return null;
            const meta = m?.metadata;
            const isNum = (v: unknown): v is number =>
              typeof v === "number" && Number.isFinite(v) && v > 0;
            const isBool = (v: unknown): v is boolean => typeof v === "boolean";
            return {
              id,
              ...(typeof m?.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
              ...(meta && isNum(meta.contextLimit) ? { contextLimit: meta.contextLimit } : {}),
              ...(meta && isNum(meta.outputLimit) ? { outputLimit: meta.outputLimit } : {}),
              ...(meta && isBool(meta.reasoning) ? { reasoning: meta.reasoning } : {}),
              ...(meta && isBool(meta.toolCall) ? { toolCall: meta.toolCall } : {}),
              ...(meta && isBool(meta.attachment) ? { attachment: meta.attachment } : {}),
            };
          })
          .filter((m): m is AcpGatewayModel => m !== null)
      : [];
    return items.length ? items.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}
import { newId } from "../../db/schema.js";
import type { Agent } from "../../db/schema.js";
import type { AgentService } from "../agents.js";
import type { AgentWorkspaceService } from "../agent-workspace.js";
import { WORKSPACE_EXEC_PATH } from "../agent-workspace.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import type { WorkspaceFs } from "@zakura/core";
import type { ServerWorkspaceFsProvider } from "../workspace-fs-provider.js";
import type { AcpRegistryService } from "./registry.js";
import { AgentHooksService } from "../agent-hooks.js";
import {
  provisionAcpMcpGatewayKey,
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
import { AcpProvisioner, type AcpResolvedAdapter } from "./provisioner.js";
import { buildAcpClient } from "./client-handlers.js";

type PendingPermission = PendingDecision<acp.RequestPermissionResponse> & {
  kind?: string;
  pathPrefix?: string;
  optionKinds: Record<string, string>;
};

export type LiveRuntime = {
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
  /** Registry adapter + version this process is executing from, when managed. */
  adapter?: { id: string; version: string };
  /** Zakura 路由：模型目录与切换都以网关别名表达 */
  zakuraRouted: boolean;
  gatewayModels?: AcpGatewayModel[];
  authMethods: Array<{ id: string; name: string; description?: string }>;
  authRequired: boolean;
  /**
   * initialize 返回的 agentCapabilities.promptCapabilities。
   * 发送 session/prompt 前据此裁剪 ContentBlock，避免向不支持的 agent 发送
   * image/audio/embedded resource 而被整轮拒绝。
   */
  promptCapabilities: AcpPromptCapabilities;
  authWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  /** When true, the ACP adapter runs in a dedicated sidecar container. */
  useSidecar: boolean;
  /**
   * When true, the adapter is PID 1 of its own container, scoped to this chat
   * session (agent × adapter × chatSessionId). Nothing was staged into the
   * workspace, so teardown skips the runtimeDir sync-back and instead removes
   * the container. The credential volume is keyed by (agent × adapter) and
   * survives teardown so the next session does not re-authenticate.
   */
  containerized: boolean;
};

/** prompt() 拒绝并发回合时使用；drainQueued 按此常量识别「已被新回合抢占」。 */
const RUN_BUSY_MESSAGE = "当前会话已有进行中的 Run，请先等待或取消";
const DRAFT_BOOT_TIMEOUT_MS = 90_000;

export class AcpSessionService {
  private readonly byChat = new Map<string, LiveRuntime>();
  /** 使超时/切换后的迟到启动结果失效 */
  private readonly draftEpoch = new Map<string, number>();
  private readonly reapTimer: ReturnType<typeof setInterval>;
  /**
   * Per-tenant concurrent ACP runtime cap. Each running (or starting)
   * LiveRuntime counts against the tenant that owns its agent. Drafts over
   * the cap are rejected with a clear message so a single tenant cannot
   * exhaust host docker/exec capacity and starve everyone else on a shared
   * multi-tenant node.
   */
  private readonly maxConcurrentPerTenant: number;
  private readonly tenantInflight = new Map<string, number>();
  /**
   * 适配器 provisioning。缓存已解析的路径，避免每次启动都 docker exec 去查
   * `.ok` 标记——标记只在安装/GC 时变，两处都会 invalidate。
   */
  private readonly provisioner: AcpProvisioner;

  constructor(
    private readonly deps: {
      agentService: AgentService;
      store: CloudAgentSessionStore;
      workspace: AgentWorkspaceService;
      workspaceFs?: ServerWorkspaceFsProvider;
      publicBaseUrl?: string;
      maxConcurrentAcpPerTenant?: number;
      /** Registry-backed on-demand adapter provisioning. */
      acpRegistry?: AcpRegistryService;
    },
  ) {
    this.hooks = new AgentHooksService(deps.workspace);
    this.deviceAuth = new CodexDeviceAuth(deps.workspace);
    this.provisioner = new AcpProvisioner({
      workspace: deps.workspace,
      registry: deps.acpRegistry,
    });
    this.maxConcurrentPerTenant = Math.max(1, deps.maxConcurrentAcpPerTenant ?? 8);
    // Let GC see which adapter versions are backing live runtimes.
    deps.acpRegistry?.setInUseVersionsProvider((agent) => this.inUseAdapterVersions(agent));
    this.reapTimer = setInterval(() => void this.reapIdle(), 60_000);
    this.reapTimer.unref?.();
  }

  /** Adapter versions currently backing a live runtime for `agent`. */
  private inUseAdapterVersions(agent: Agent): Array<{ id: string; version: string }> {
    const out = new Map<string, { id: string; version: string }>();
    for (const rt of this.byChat.values()) {
      if (rt.agent.id !== agent.id || !rt.adapter) continue;
      out.set(`${rt.adapter.id}@${rt.adapter.version}`, rt.adapter);
    }
    return [...out.values()];
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
    if (this.countTenantActive(input.tenantId) >= this.maxConcurrentPerTenant) {
      throw new Error(
        `已达到该租户的最大并发 ACP 会话数（${this.maxConcurrentPerTenant}），请等待已有会话结束或回收后再试`,
      );
    }
    const session = await this.deps.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agentId,
      title: `ACP · ${setup.displayName || setup.id}`,
      kind: "acp",
      project: input.project ?? null,
      origin: { runtime: "acp", acpProfileId: setup.id },
    });
    // Reserve a booting slot so concurrent prepareDraft calls for the same
    // tenant are capped even before any runtime reaches byChat. The slot is
    // released when startDraftRuntime settles (success or failure); the
    // running runtime itself is then tracked via byChat + countTenantActive.
    this.tenantInflightInc(input.tenantId);
    void this.startDraftRuntime(agent, session.id, setup).finally(() =>
      this.tenantInflightDec(input.tenantId),
    );
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

  /**
   * Running runtimes in byChat plus booting drafts tracked by tenantInflight.
   * Both count against the per-tenant concurrency cap so a tenant cannot
   * exhaust host capacity via either running agents or a flood of parallel
   * cold starts.
   */
  private countTenantActive(tenantId: string): number {
    let n = this.tenantInflight.get(tenantId) ?? 0;
    for (const live of this.byChat.values()) {
      if (live.agent.tenantId === tenantId) n += 1;
    }
    return n;
  }

  private tenantInflightInc(tenantId: string): void {
    this.tenantInflight.set(tenantId, (this.tenantInflight.get(tenantId) ?? 0) + 1);
  }

  private tenantInflightDec(tenantId: string): void {
    const cur = (this.tenantInflight.get(tenantId) ?? 0) - 1;
    if (cur <= 0) this.tenantInflight.delete(tenantId);
    else this.tenantInflight.set(tenantId, cur);
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
      if (this.draftEpoch.get(sessionId) !== epoch) {
        // Superseded by a newer turn — the draft that won the race is no longer
        // wanted, so tear it down and release its concurrency slot.
        if (live) await this.teardown(live).catch(() => undefined);
        return;
      }
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
    /** 随消息一同发送的附件；按 agent 的 promptCapabilities 内联或降级为 resource_link */
    attachments?: CloudAgentAttachment[] | null;
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
      attachments: input.attachments ?? null,
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

  /**
   * 把一轮用户输入构建成 ACP ContentBlock[]。
   *
   * 规则（严格遵循 spec）：
   * - text 恒发送；
   * - image/audio 仅在 agent 声明对应 promptCapabilities 时才 base64 内联；
   * - 其余（含能力不支持、体积过大、读取失败）一律降级为 resource_link ——
   *   resource_link 无需能力声明，任何 agent 都能收下，最差情况也只是让
   *   agent 自己去 fs/read_text_file，而不会整轮 prompt 被拒。
   */
  private async buildPromptBlocks(input: {
    agent: Agent;
    content: string;
    attachments: CloudAgentAttachment[] | null;
    capabilities: AcpPromptCapabilities;
  }): Promise<acp.ContentBlock[]> {
    const plan = planAcpPromptBlocks({
      text: input.content,
      attachments: input.attachments ?? [],
      capabilities: input.capabilities,
      workspaceRoot: AGENT_WORKSPACE_ROOT,
    });

    const blocks: acp.ContentBlock[] = [];
    if (plan.text) blocks.push({ type: "text", text: plan.text });
    if (plan.items.length === 0) return blocks;

    const provider = this.deps.workspaceFs;
    let fs: WorkspaceFs | undefined;

    const asLink = (item: AcpPromptBlockPlanItem): acp.ContentBlock => ({
      type: "resource_link",
      uri: item.uri,
      name: item.attachment.name || item.attachment.path,
      ...(item.attachment.mime ? { mimeType: item.attachment.mime } : {}),
      ...(typeof item.attachment.size === "number"
        ? { size: item.attachment.size }
        : {}),
    });

    for (const item of plan.items) {
      if (item.action === "link" || !provider) {
        blocks.push(asLink(item));
        continue;
      }
      try {
        if (fs === undefined) {
          fs = await provider.forAgentBinding({
            id: input.agent.id,
            tenantId: input.agent.tenantId,
            runtimeNodeId: input.agent.runtimeNodeId,
          });
        }
        const file = await fs.readBytes(item.attachment.path);
        if (file.data.length === 0) {
          blocks.push(asLink(item));
          continue;
        }
        blocks.push({
          type: item.blockType,
          data: file.data.toString("base64"),
          mimeType: item.attachment.mime || "application/octet-stream",
          ...(item.blockType === "image" ? { uri: item.uri } : {}),
        } as acp.ContentBlock);
      } catch {
        // 文件被移动/删除/权限问题：降级为链接，不阻断这一轮对话
        blocks.push(asLink(item));
      }
    }
    return blocks;
  }

  private async runPromptTurn(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    content: string;
    attachments?: CloudAgentAttachment[] | null;
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
    const promptBlocks = await this.buildPromptBlocks({
      agent: input.agent,
      content: input.content,
      attachments: input.attachments ?? null,
      capabilities: live.promptCapabilities,
    });
    void active.prompt(promptBlocks).then(
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
      promptCapabilities: live?.promptCapabilities,
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
    const live = await this.requireLive(tenantId, agentId, sessionId);
    await live.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: live.active!.sessionId,
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
    const session = await this.deps.store.getSession(tenantId, agentId, sessionId);
    if (!session) throw new Error("会话不存在");
    if (session.kind !== "acp") throw new Error("不是 ACP 会话");
    await this.deps.store.updateSession(tenantId, agentId, sessionId, { model: modelId });

    const inflight = this.starting.get(sessionId);
    if (inflight) await inflight.catch(() => undefined);

    let live = this.byChat.get(sessionId);
    if (live?.runId) throw new Error("当前 ACP 任务运行中，完成后再切换模型");
    // Pin before setConfigOption: Codex 回包会带官方模型目录，overlay 要以
    // 用户刚选的网关别名为准，不能被适配器 currentId 盖掉。
    if (live?.models) live.models = { ...live.models, currentId: modelId };

    const configId = live ? dynamicModelConfigId(live) : undefined;
    if (live?.active && configId) {
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

    // 无热切换（Codex/Grok 等不认网关别名）或进程已不在：走启动参数。
    // 进程未起来时不要抛「未启动」——刷新/回收后再改模型是正常路径。
    const origin = safeOrigin(session.originJson);
    const previousAcpSessionId = live?.acpSessionId ?? origin.acpSessionId;
    const profileId = live?.profileId ?? origin.acpProfileId;
    if (!profileId) throw new Error("会话未绑定 ACP profile");
    if (live) await this.teardown(live, { keepSession: true });
    const agent = await this.deps.agentService.get(tenantId, agentId);
    if (!agent) throw new Error("Agent 不存在");
    const setup = requireSetup(agent, profileId);
    await this.ensureRuntime(agent, sessionId, setup, {
      existingAcpSessionId: previousAcpSessionId,
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
    const live = await this.requireLive(tenantId, agentId, sessionId);
    const payload =
      typeof value === "boolean"
        ? { sessionId: live.active!.sessionId, configId, value, type: "boolean" as const }
        : { sessionId: live.active!.sessionId, configId, value };
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
      // url 模式会以 requestId + elicitationId 两个键登记同一个 pending，
      // 这里按引用清理所有别名，避免留下永远不会被 resolve 的悬挂条目。
      for (const [key, value] of live!.elicitations) {
        if (value === pending) live!.elicitations.delete(key);
      }
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
    await this.deps.workspace.ensureStarted(agent, { require: "shell" }).catch(() => undefined);
    const result = await this.deps.workspace.execInWorkspace(agent, [
      "bash",
      "-lc",
      `${acpCommandResolveExpr(launch.command, "ZAKURA_ACP_PROBE")}; ` +
        `printf '%s\\n' "$ZAKURA_ACP_PROBE"; exec "$ZAKURA_ACP_PROBE" --version`,
    ]);
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      installed: result.exitCode === 0,
      command: [launch.command, ...launch.args].join(" "),
      output: output.slice(0, 4000),
    };
  }

  /**
   * 手动安装/更新一个 profile 的适配器。
   *
   * 以前这里对 `builtin` 直接抛「已预装在镜像中」——那是 adapters 还烤进镜像时
   * 的遗留。现在镜像只带 Node/uv，28 个内置 profile 全部按需装，于是那条分支
   * 等于让每个内置 agent 的安装按钮必定失败。
   *
   * 现在按 profile 的实际来源分派：
   *   - preinstalled（仅 fx@full 镜像）→ 无需安装，probe 一下确认可用即可
   *   - registry 源 → 交给 AcpRegistryService，走 pin 版本 + sha256 + 原子切换
   *   - custom/自定义 → 沿用 installHint 白名单
   */
  async install(
    agent: Agent,
    profileId: string,
  ): Promise<{ ok: boolean; command: string; output: string }> {
    const setup = requireSetup(agent, profileId, true);
    const profile = publicProfileForSetup(setup);

    if (profile.preinstalled) {
      const probed = await this.probe(agent, profileId);
      return {
        ok: probed.installed,
        command: probed.command,
        output: probed.installed
          ? `${profile.displayName} 随工作区镜像出厂，无需安装。\n${probed.output}`
          : `${profile.displayName} 应随镜像出厂，但当前工作区里没找到。` +
            `可能用的是 lite/shell 镜像，或镜像版本过旧。\n${probed.output}`,
      };
    }

    const registryId = acpRegistryIdForProfile(profileId);
    const registry = this.deps.acpRegistry;
    if (registryId && registry) {
      const res = await registry.ensureInstalled(agent, registryId);
      this.invalidateProvisionCache(agent.id, profileId);
      return {
        ok: true,
        command: [res.command, ...res.args].join(" "),
        output: res.installed
          ? `已安装 ${profile.displayName} ${res.version}`
          : `${profile.displayName} ${res.version} 已是最新，跳过安装`,
      };
    }

    if (!profile.installHint) throw new Error("该 profile 没有安装命令");
    if (!isSafeInstallHint(profile.installHint)) {
      throw new Error("安装命令不在允许列表内，请用 self 模式自行安装");
    }
    await this.deps.workspace.ensureStarted(agent, { require: "shell" });
    const result = await this.deps.workspace.execInWorkspace(
      agent,
      ["bash", "-lc", profile.installHint],
      { timeoutMs: 180_000 },
    );
    this.invalidateProvisionCache(agent.id, profileId);
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.exitCode === 0,
      command: profile.installHint,
      output: output.slice(0, 8000),
    };
  }

  /**
   * Invalidate the in-memory provision cache for an agent/profile.
   * Called after manual install, adapter update, or workspace recreation.
   */
  invalidateProvisionCache(agentId: string, profileId?: string): void {
    this.provisioner.invalidate(agentId, profileId);
  }

  /**
   * Background pre-warm: provision the adapter so the first ACP boot
   * skips the install step entirely. Called when an ACP profile is saved
   * or when the workspace starts.
   */
  async preWarmAdapter(agent: Agent, profileId: string): Promise<void> {
    try {
      const setup = requireSetup(agent, profileId, true);
      const profile = publicProfileForSetup(setup);
      const launch = resolveAcpLaunch(profile, setup);
      await this.provisionAdapter(agent, profileId, launch.command, true);
    } catch {
      // Pre-warm is best-effort; failure is not actionable until boot.
    }
  }

  /** 改模型/思考/模式时进程可能已被回收或尚未拉起；先等到可用再 RPC。 */
  private async requireLive(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<LiveRuntime> {
    const inflight = this.starting.get(sessionId);
    if (inflight) {
      const live = await inflight;
      if (live.active) return live;
    }
    const existing = this.byChat.get(sessionId);
    if (existing?.active) return existing;

    const session = await this.deps.store.getSession(tenantId, agentId, sessionId);
    if (!session) throw new Error("会话不存在");
    if (session.kind !== "acp") throw new Error("不是 ACP 会话");
    const origin = safeOrigin(session.originJson);
    if (!origin.acpProfileId) throw new Error("会话未绑定 ACP profile");
    const agent = await this.deps.agentService.get(tenantId, agentId);
    if (!agent) throw new Error("Agent 不存在");
    const setup = requireSetup(agent, origin.acpProfileId);
    const live = await this.ensureRuntime(agent, sessionId, setup, {
      existingAcpSessionId: origin.acpSessionId,
    });
    if (!live.active) throw new Error("ACP runtime 未启动");
    return live;
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

  /**
   * Resolve the aggregated MCP gateway endpoint handed to the ACP agent.
   *
   * Returns `undefined` when no public base URL is configured, in which case
   * the caller falls back to the legacy per-binding fan-out.
   */
  private async resolveMcpGateway(
    agent: Agent,
    profileId: string,
  ): Promise<{ baseUrl: string; slug: string; apiKey: string } | undefined> {
    const baseUrl = this.deps.publicBaseUrl?.trim();
    if (!baseUrl) return undefined;
    try {
      const config = readAgentAcpConfig(agent);
      const { apiKey } = await provisionAcpMcpGatewayKey(
        this.deps.agentService,
        agent.tenantId,
        agent,
        config,
        profileId,
      );
      if (!apiKey) return undefined;
      return { baseUrl, slug: agent.slug, apiKey };
    } catch {
      // Never let credential provisioning break session start; fall back to
      // the legacy per-binding list instead.
      return undefined;
    }
  }

  /**
   * Make sure the adapter for `profileId` exists, returning its resolved command.
   *
   * Delegates to AcpProvisioner; when sidecar mode is active the adapter is
   * installed in the sidecar container (which shares the same /workspace bind
   * mount), otherwise in the workspace container (legacy path).
   */
  private async provisionAdapter(
    agent: Agent,
    profileId: string,
    currentCommand: string,
    useSidecar: boolean,
  ): Promise<AcpResolvedAdapter | null> {
    return this.provisioner.resolve(agent, profileId, currentCommand, useSidecar);
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

    // Try to use a dedicated ACP sidecar container for the adapter process.
    // If the sidecar image is not available (not yet built/pushed), fall back
    // to running the adapter inside the workspace container — identical to the
    // pre-sidecar behavior and always works.
    let useSidecar = true;

    // Workspace container is always needed for terminal/fs callbacks.
    const workspaceReady = this.deps.workspace
      .ensureStarted(agent, { require: "shell" })
      .catch(() => undefined);
    const sidecarReady = this.deps.workspace
      .ensureAcpSidecar(agent)
      .catch((err) => {
        // Sidecar unavailable — gracefully degrade to in-workspace mode.
        useSidecar = false;
        console.warn(`[acp] sidecar 不可用，回退到 workspace 模式：${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });

    // Repair legacy Zakura ACP profiles at the point of use as well as in the
    // settings route. This closes the path where a user starts chat directly
    // with an old profile that has no persisted Gateway key yet.
    //
    // Provisioning (DB read + write), the workspace container start, and the
    // gateway model list fetch are all independent — run them concurrently so
    // container warm-up overlaps with both instead of stacking serially.
    // Auto-migrate legacy fx agents: older defaults used setupMode="self" +
    // modelProvider="native" with no managed key, which causes fx to fail at
    // initialize ("ACP connection closed"). fx supports Zakura route, so flip
    // it to zakura routing automatically when no native credential is present.
    if (
      setup.id === "fx" &&
      setup.modelProvider === "native" &&
      setup.setupMode === "self" &&
      !setup.managed.api_key?.trim() &&
      this.deps.publicBaseUrl
    ) {
      const config = readAgentAcpConfig(agent);
      const fxSetup = config.agents["fx"];
      if (fxSetup) {
        fxSetup.modelProvider = "zakura";
        fxSetup.setupMode = "api_key";
        await saveAgentAcpConfig(this.deps.agentService, agent.tenantId, agent, config);
        setup = fxSetup;
      }
    }

    const provisionP =
      setup.modelProvider === "zakura" && this.deps.publicBaseUrl
        ? provisionAcpZakuraRoutes(
            this.deps.agentService,
            agent.tenantId,
            agent,
            readAgentAcpConfig(agent),
            this.deps.publicBaseUrl,
          )
        : Promise.resolve(null);
    // Fetch the gateway model alias list in parallel with the container boot;
    // it only needs the Gateway endpoint, never the workspace.
    const gatewayModelsP =
      setup.modelProvider === "zakura" &&
      setup.managed.zakura_base_url?.trim() &&
      setup.managed.zakura_api_key?.trim()
        ? fetchAcpGatewayModels(
            setup.managed.zakura_base_url!,
            setup.managed.zakura_api_key!,
          )
        : Promise.resolve(undefined);
    const [provisioned] = await Promise.all([provisionP, workspaceReady, sidecarReady]);
    if (provisioned) setup = provisioned.agents[setup.id] ?? setup;
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
    // 未显式选模型时优先沿用 Agent 的 Zakura 默认 chat 模型，
    // 避免落到网关列表里排最前的免费模型。
    let preferredModel: string | undefined;
    try {
      preferredModel =
        parseCloudAgentConfig(JSON.parse(agent.configJson || "{}")).model?.trim() || undefined;
    } catch {
      preferredModel = undefined;
    }
    // gatewayModelsP was started alongside the container boot above.
    const gatewayModels = await gatewayModelsP;
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
    const writeScript = writes
      .map((w) => {
        const b64 = Buffer.from(w.content, "utf8").toString("base64");
        return `mkdir -p ${shellSingle(dirnameSh(w.dest))} && printf '%s' ${shellSingle(b64)} | base64 -d > ${shellSingle(w.dest)} && chmod 600 ${shellSingle(w.dest)}`;
      })
      .join(" && ");
    // Fold the `command -v <adapter>` check into the staging exec so the whole
    // prep — durable copy + generated config files + binary presence check —
    // is a single docker exec round trip instead of two.
    // Must use the exact same resolution the real launch uses (ACP bin dir before
    // PATH), or this check and `acpStdioArgv` can disagree: the probe says
    // "not installed" while the binary is sitting in /opt/zakura/acp/bin, or vice
    // versa. Both now go through `acpCommandResolveExpr`.
    // Adapters are no longer baked into the workspace image; make sure this one is
    // present (a no-op once installed) and take the resolved absolute path. Older
    // images that still carry pre-baked adapters keep working: `provision` returns
    // null for them and we fall back to the profile's own command.
    // ── Containerized adapter ───────────────────────────────────────────────
    // The adapter binary is the container CMD (PID 1), its filesystem ships
    // with the image and its credentials live on a dedicated volume. None of
    // the workspace staging below applies: nothing to copy, nothing to
    // install, no binary to probe. We skip straight to attaching to PID 1.
    const adapterSource = acpAdapterSource(setup.id);
    const containerImage = adapterSource.kind === "container" ? adapterSource.image : null;

    const execFn = useSidecar
      ? (cmd: string[]) => this.deps.workspace.execInSidecar(agent, cmd)
      : (cmd: string[]) => this.deps.workspace.execInWorkspace(agent, cmd);
    const cleanupRuntimeDir = async () => {
      if (containerImage) return; // no runtimeDir was staged
      await execFn(["bash", "-lc", `rm -rf ${shellSingle(layout.runtimeDir)}`])
        .catch(() => undefined);
    };

    let adapterBin: Awaited<ReturnType<AcpSessionService["provisionAdapter"]>> = null;
    if (!containerImage) {
      adapterBin = await this.provisionAdapter(agent, setup.id, launch.command, useSidecar);
      if (adapterBin) {
        launch.command = adapterBin.command;
        if (adapterBin.args.length && !setup.args?.length) {
          launch.args = adapterBin.args;
        }
      }

      const whichCheck = acpCommandResolveExpr(launch.command, "ZAKURA_ACP_PROBE");
      const prep = writeScript
        ? `${acpStageScript(layout)}\n${writeScript}\n${whichCheck}`
        : `${acpStageScript(layout)}\n${whichCheck}`;
      try {
        const result = await execFn(["bash", "-lc", prep]);
        if (result.exitCode !== 0) {
          const stderr = (result.stderr ?? "").trim();
          if (stderr.includes("ZAKURA_BIN_MISSING")) {
            throw new Error(`工作区里找不到 ${launch.command}（容器内未安装该 Agent CLI，请到 Runner 详情页检查镜像更新并重建工作区后重试）`);
          }
          throw new Error(`工作区初始化脚本失败（exit ${result.exitCode}）：${stderr || "无 stderr 输出"}`);
        }
      } catch (err) {
        await cleanupRuntimeDir();
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ZAKURA_BIN_MISSING")) {
          throw new Error(`工作区里找不到 ${launch.command}`);
        }
        throw err;
      }
    }

    const env: Record<string, string> = { ...launch.env, ...layout.env };

    // npx-provisioned adapters live under `<dir>/node_modules/.bin`. Some shell out
    // to a companion CLI (e.g. pi-acp runs `pi`, installed alongside via
    // extraPackages) and resolve it from PATH, so prepend the adapter's own .bin dir.
    if (adapterBin && adapterBin.command.includes("/node_modules/.bin/")) {
      const binDir = adapterBin.command.slice(0, adapterBin.command.lastIndexOf("/"));
      env.PATH = `${binDir}:${env.PATH ?? WORKSPACE_EXEC_PATH}`;
    }

    let stdio: Awaited<ReturnType<AgentWorkspaceService["startStdio"]>>;
    try {
      if (containerImage) {
        // Adapter is PID 1 of its own container: start/reuse it and attach.
        // Scoped by chatSessionId — one PID 1 can serve only one JSON-RPC peer
        // (Docker broadcasts its stdout to every attach and merges their stdin).
        stdio = await this.deps.workspace.attachStdioInAcpAdapter(
          agent,
          setup.id,
          containerImage,
          chatSessionId,
          { env },
        );
      } else {
        const argv = acpStdioArgv(launch.command, launch.args);
        stdio = useSidecar
          ? await this.deps.workspace.startStdioInSidecar(agent, argv, { workingDir: cwd, env })
          : await this.deps.workspace.startStdio(agent, argv, { workingDir: cwd, env });
      }
    } catch (err) {
      await cleanupRuntimeDir();
      throw err;
    }

    // Capture the agent process's stderr. Until now these bytes were silently
    // discarded (startStdio only forwarded stdout for JSON-RPC), so every fx
    // startup failure surfaced as the vague "ACP connection closed" with no
    // real cause. The Docker mux stream separates stderr cleanly; we keep a
    // bounded tail so bootRuntime's catch path can attach it to the error.
    let stderrTail = "";
    stdio.onStderr((chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
      // Live stderr is also the fastest signal when fx/codex/etc. misbehave;
      // surface it on the server log for offline diagnosis.
      process.stderr.write(`[acp:${setup.id}] ${chunk}`);
    });

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
      promptCapabilities: {},
      authWaiters: [],
      useSidecar,
      // Lets GC know this version is in use, so an update triggered mid-session
      // does not prune the directory this process is running from.
      // In container mode adapterBin stays null (no runtime dir is staged, so
      // there is nothing for GC to prune), and this spread collapses to nothing.
      ...(adapterBin?.registryId && adapterBin.version
        ? { adapter: { id: adapterBin.registryId, version: adapterBin.version } }
        : {}),
      containerized: containerImage !== null,
      ...(opts?.runId ? { runId: opts.runId } : {}),
    };

    const config = readAgentAcpConfig(agent);
    live.permissionGrants = config.permissionGrants.slice();
    const stream = acp.ndJsonStream(stdio.writable, stdio.readable);
    const app = buildAcpClient({
      deps: this.deps,
      live,
      agent,
      chatSessionId,
      config,
      hooks: this.hooks,
    });
    live.connection = app.connect(stream);
    this.byChat.set(chatSessionId, live);
    try {
      // initialize 也可能在缺凭证时返回 auth-required（fx 无 AI_GATEWAY_API_KEY
      // 时返回 code -32600）。把它和 openSession 一样纳入 auth-elicitation 重试，
      // 否则 initialize 的 auth 错误会落到外层 catch 被当成普通崩溃抛出。
      // withAuthRetry 保持内联 request 的原始推断类型，不抽成闭包（会丢重载类型）。
      const init = await withAuthRetry(this.deps.store, live, () =>
        live.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            elicitation: { form: {}, url: {} },
            session: { configOptions: { boolean: {} } },
          },
          clientInfo: { name: "zakura", title: "Zakura", version: "0.1.0" },
        }),
      );
      live.authMethods = (init.authMethods ?? []).map((m) => ({
        id: String(m.id),
        name: String(m.name || m.id),
        ...(typeof m.description === "string" && m.description
          ? { description: m.description }
          : {}),
      }));
      live.promptCapabilities = normalizePromptCapabilities(
        init.agentCapabilities?.promptCapabilities,
      );

      const mcpServers =
        init.agentCapabilities?.mcpCapabilities?.http || profile.forceHttpMcp
          ? await listHttpMcpServers(
              this.deps.agentService,
              agent.tenantId,
              agent.id,
              await this.resolveMcpGateway(agent, setup.id),
            )
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

      await withAuthRetry(this.deps.store, live, openSession);

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
          [launchSetup.managed.model, preferredModel],
        );
        // Apply the configured model before the first prompt.  ACP exposes
        // model selection only after session/new, so waiting for the chat
        // toolbar would otherwise make the first turn run on the adapter's
        // implicit default.
        const preferredModelId =
          launchSetup.managed.model?.trim() || gatewayModels?.[0]?.id;
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
        this.byChat.delete(chatSessionId);
      });
      return live;
    } catch (err) {
      await this.teardown(live).catch(() => undefined);
      await cleanupRuntimeDir();
      // "ACP connection closed" 是 Agent 进程在 initialize 前后退出导致的含糊报错。
      // 现在有了 stderr 尾部就优先用它——fx 缺凭证/版本不兼容等真正的退出原因都在
      // stderr 里；只有真的没有 stderr 时才回退到「镜像过旧」的猜测提示。
      throw toAcpConnectionHint(err, stderrTail);
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
    preferredModels?: Array<string | undefined>,
  ): Promise<void> {
    const parsed = parseAcpSessionModelState(raw);
    const models = parsed.models
      ? overlayAcpGatewayModels({
          zakuraRouted: live.zakuraRouted,
          gatewayModels: live.gatewayModels,
          incoming: parsed.models,
          previous: live.models,
          preferred: preferredModels,
        })
      : undefined;
    if (models) live.models = models;
    if (parsed.reasoning) live.reasoning = parsed.reasoning;
    if (!models && !parsed.reasoning) return;
    await this.deps.store.appendEvent({
      sessionId,
      type: "session_update",
      ...(runId ? { runId } : {}),
      payload: {
        ...(models ? { acpModels: models } : {}),
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
    if (live.containerized) {
      // `kill()` only tears down the attach stream. The container is scoped to
      // this chat session, so nothing else can reuse it — remove it or it
      // leaks one container per ended session. The credential volume is keyed
      // by (agent × adapter) and deliberately survives.
      await this.deps.workspace
        .stopAcpAdapterContainer(live.agent, live.profileId, live.chatSessionId)
        .catch(() => undefined);
    } else {
      // Sync back runtime state; use the same container the adapter ran in.
      // Containerized adapters stage nothing into the workspace, so there is
      // no runtimeDir to sync back.
      const syncExec = live.useSidecar
        ? (cmd: string[]) => this.deps.workspace.execInSidecar(live.agent, cmd)
        : (cmd: string[]) => this.deps.workspace.execInWorkspace(live.agent, cmd);
      await syncExec(["bash", "-lc", acpSyncBackScript(live.layout)])
        .catch(() => undefined);
    }
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

type AcpModelsBlock = NonNullable<AcpRuntimeStatus["models"]>;

/**
 * Zakura 路由下适配器公告的目录（Codex 内置 gpt、pi 自家目录等）对网关无效。
 * 列表始终挂网关别名；currentId 优先保留已选网关模型，避免 setConfigOption
 * （例如改思考强度）把官方 current 写回来。
 */
export function overlayAcpGatewayModels(input: {
  zakuraRouted: boolean;
  gatewayModels?: AcpGatewayModel[];
  incoming: AcpModelsBlock;
  previous?: AcpModelsBlock;
  preferred?: Array<string | undefined>;
}): AcpModelsBlock {
  const gateway = input.gatewayModels;
  if (!input.zakuraRouted || !gateway?.length) return input.incoming;
  const candidates = [
    input.previous?.currentId,
    ...((input.preferred ?? []).map((id) => id?.trim())),
    input.incoming.currentId,
  ].map((id) => id?.replace(/^zakura\//, ""));
  const current =
    candidates.find((id): id is string => Boolean(id && gateway.some((m) => m.id === id))) ??
    gateway[0]!.id;
  return {
    currentId: current,
    available: gateway.map((m) => ({ id: m.id, name: m.name || m.id })),
    configId: input.incoming.configId ?? input.previous?.configId,
  };
}

/**
 * 运行时热切换模型的 configId。Zakura 路由下列表是网关别名，只有
 * OpenCode 认 `zakura/<alias>`；Codex/Grok 等拿网关 id 去 setConfigOption
 * 会 Invalid params，必须走启动参数 / config.toml。
 */
export function acpHotModelConfigId(live: {
  zakuraRouted: boolean;
  profileId: string;
  models?: { configId?: string };
}): string | undefined {
  if (live.zakuraRouted && live.profileId !== "opencode") return undefined;
  const configId = live.models?.configId;
  return configId && configId !== ACP_UNSTABLE_MODEL_CONFIG_ID && !configId.startsWith("_")
    ? configId
    : undefined;
}

/** Only a config option announced by session/new is safe to set at runtime. */
function dynamicModelConfigId(live: LiveRuntime): string | undefined {
  return acpHotModelConfigId(live);
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

/**
 * 归一化 initialize 返回的 promptCapabilities。
 * spec 中这些字段均为可选 boolean，缺省即 false；text 与 resource_link 恒可用，
 * 因此不出现在能力表里。任何非 boolean 值一律按 false 处理（保守降级）。
 */
function normalizePromptCapabilities(raw: unknown): AcpPromptCapabilities {
  if (!raw || typeof raw !== "object") return {};
  const caps = raw as Record<string, unknown>;
  const pick = (key: string): boolean => caps[key] === true;
  return {
    image: pick("image"),
    audio: pick("audio"),
    embeddedContext: pick("embeddedContext"),
  };
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

/**
 * Build the MCP server list handed to an ACP agent at `session/new`.
 *
 * We deliberately expose a SINGLE aggregated endpoint (this project's own MCP
 * gateway at `/mcp/agents/:slug`) instead of fanning out one entry per binding.
 *
 * Why this matters, beyond tidiness:
 *
 *  1. Every entry in `session/new.mcpServers` is REQUIRED by the ACP wire
 *     protocol - `McpServer` has no `optional`/`enabled` field. So a single
 *     unreachable or subtly non-conforming upstream aborts the whole session
 *     with "Required MCP server '<name>' failed to start", and the user loses
 *     the agent entirely rather than just one tool.
 *  2. Upstreams vary in spec conformance. Observed in the wild: mcp.grep.app
 *     answers `notifications/initialized` with a bare `202` carrying no
 *     `content-type` header. That is legal per the MCP spec (a 202 has no
 *     body), but the `fx` client rejects it with `MissingContentType` and
 *     treats the server as failed to start. Fronting upstreams with our own
 *     gateway normalises these differences in exactly one place.
 *  3. The gateway already namespaces aggregated tools as `re_<slug>__<tool>`,
 *     so collapsing to one endpoint does not create tool-name collisions.
 *
 * Falls back to the legacy per-binding fan-out when no gateway credentials are
 * available, so self-hosted setups without a reachable public base URL keep
 * working exactly as before.
 */
export async function listHttpMcpServers(
  agentService: AgentService,
  tenantId: string,
  agentId: string,
  gateway?: { baseUrl: string; slug: string; apiKey: string },
): Promise<acp.McpServer[]> {
  if (gateway) {
    const base = gateway.baseUrl.replace(/\/+$/, "");
    return [
      {
        type: "http",
        name: "zakura",
        url: `${base}/mcp/agents/${encodeURIComponent(gateway.slug)}`,
        headers: [{ name: "Authorization", value: `Bearer ${gateway.apiKey}` }],
      },
    ];
  }
  const bindings = await agentService.listBindings(tenantId, agentId);
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
  if (/auth[_ ]?required/i.test(msg)) return true;
  // fx (and similar native agents) fail initialize with code -32600 when no
  // AI Gateway credential is configured. Treat this as auth-required so the
  // elicitation flow can guide the user through `fx login` / `fx setup`.
  if (data && (data.code === -32600 || data.error === -32600)) return true;
  if (/fx needs access|AI_GATEWAY_API_KEY|run fx login/i.test(msg)) return true;
  return false;
}

/**
 * Agent 进程在握持 stdio 阶段（initialize 或之前）就退出，导致 ACP SDK 把
 * pending request reject 成 "ACP connection closed"。最常见原因是工作区
 * 镜像过旧——里面没装该 Agent 的 CLI（如 fx），或版本过旧不兼容当前协议。
 * 识别后转成可操作提示，而不是把含糊的 "ACP connection closed" 原样抛给用户。
 */
export function isAcpConnectionClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ACP connection closed|ACP Agent 进程意外退出|connection closed/i.test(msg);
}

/** 把 connection-closed 类错误转成可操作提示。非此类错误原样返回。 */
function toAcpConnectionHint(err: unknown, stderrTail?: string): unknown {
  if (!isAcpConnectionClosed(err)) {
    if (stderrTail?.trim()) return new Error(`${describeAcpRpcError(err).message}\n${stderrTail.trim()}`);
    return err;
  }
  // 有 stderr 时优先暴露真实原因（fx 缺凭证、版本不兼容、fx needs access 等），
  // 不再只猜测「镜像过旧」。stderr 尾部足以定位绝大多数启动失败。
  if (stderrTail?.trim()) {
    return new Error(
      `Agent 进程在初始化时退出。进程 stderr 尾部：\n${stderrTail.trim()}`,
    );
  }
  return new Error(
    "Agent 进程在初始化时退出且未输出 stderr。这通常是工作区镜像过旧（未预装该 Agent 的 CLI 或版本不兼容），请到 Runner 详情页检查镜像更新并重建工作区后重试。",
  );
}

/**
 * 执行一个 ACP RPC；若抛出 auth-required（fx 无凭证时 initialize 返回 -32600），
 * 触发登录 elicitation、等待用户登录后重试一次。initialize 与 openSession 共用。
 * 泛型 T 保留 thunk 的精确返回类型（含 SDK 方法重载推断）。
 */
async function withAuthRetry<T>(
  store: CloudAgentSessionStore,
  live: LiveRuntime,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!isAuthRequiredError(err)) throw err;
    live.authRequired = true;
    await emitAuthElicitation(store, live);
    await waitForAuth(live);
    live.authRequired = false;
    return op();
  }
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
