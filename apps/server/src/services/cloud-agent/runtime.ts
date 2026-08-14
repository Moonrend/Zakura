/**
 * Cloud Agent 运行时编排：三条执行路径共用 ./loop.js 的统一引擎，
 * 差异只在上下文构建与工具面：
 * - 主对话（kind=chat）：分支链历史 + 记忆召回 + 委派/子代理工具
 * - 子代理（kind=subagent）：隔离上下文，任务契约提示词，剔除派生工具防递归
 * - 跨 Agent 委派（kind=delegate）：目标 Agent 的身份、工具与提示词
 *
 * 所有路径的对话历史（含系统触发的）都以各自类型标记的会话完整落库，
 * 可经同一事件流 SSE 实时观看与回放；父会话 tool_call_result 携带
 * childSessionId 链接到派生会话。
 */
import { loadProjectContext, type LoadedProjectContext } from "../project-config.js";
import {
  lastCancelledRunId,
  parseCloudAgentConfig,
  projectDefaultWorkingDir,
  isGitCommitCommand,
  type CloudAgentAttachment,
  type CloudAgentConfig,
  type CloudAgentContextSourceItem,
  type CloudAgentFollowUpMode,
  type CloudAgentRunOptions,
  type CloudAgentSessionOrigin,
  type ModelChatContentPart,
  type ModelChatMessage,
  type ModelToolDefinition,
} from "@zakura/shared";
import {
  getTelemetry,
  idsFromSession,
  recordPlatformFault,
  withLogContext,
  type WorkspaceFsProvider,
  type WorkspaceFs,
} from "@zakura/core";
import { recordUserUsage } from "../user-usage.js";
import type { Agent } from "../../db/schema.js";
import { newId } from "../../db/schema.js";
import { SUBAGENT_TOOL_QUALIFIED, type McpGateway } from "../mcp-gateway.js";
import {
  isAbortError,
  mapConcurrent,
  ModelCallAbortedError,
} from "../../model-router/http.js";
import type { ModelRouterService } from "../model-router.js";
import type { AgentService } from "../agents.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import type { MemoryStore } from "../memory-store.js";
import type { MemoryProvidersService } from "../memory-providers.js";
import {
  buildMemoryContext,
  resolveAgentMemory,
  type ResolvedMemory,
} from "../memory-runtime.js";
import { estimateMessagesTokens } from "@zakura/shared";
import {
  approxMessagesChars,
  buildCompactionDigest,
  buildCompactionSystemPrompt,
  buildChainMessages,
  extractFileOpsFromMessages,
  fileOpsFromCompactionPayload,
  formatHistorySummaryForPrompt,
  isOverHardBudget,
  isOverSoftBudget,
  mergeFileOps,
  parseAttachments,
  parseFileOpsFromSummary,
  prepareHistoryForModel,
  resolveCompactBudget,
  resolveCompactBudgetForContextWindow,
  splitMessagesForCompaction,
  type CompactBudget,
  type CompactionFileOps,
  WORKSPACE_IMAGE_PREFIX,
  guessImageMime,
} from "./messages.js";
import {
  DELEGATE_TOOL_NAME,
  RESULT_TEXT_LIMIT,
  parseToolArgs,
  toolsToDefinitions,
} from "./tools.js";
import { buildSubagentPrompt, buildSystemPrompt, CONTINUE_TURN_PROMPT } from "./prompts.js";
import { extractAndSaveMemories } from "./memory.js";
import {
  appendRunLog,
  failRun,
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopHooks,
  type LoopToolOutcome,
} from "./loop.js";
import {
  collectInjectText,
  firstDeny,
} from "../agent-hooks.js";
import {
  callRemoteChannelTool,
  isRemoteChannelToolName,
  listRemoteChannelToolDefinitions,
  remoteChannelPromptBlock,
} from "../remote-channel-tools.js";
import {
  callSessionTool,
  isSessionToolName,
  listSessionToolDefinitions,
} from "./session-tools.js";
import {
  callAutomationTool,
  isAutomationToolName,
  listAutomationToolDefinitions,
} from "./automation-tools.js";
import {
  callCrisisSupportTool,
  isCrisisSupportToolName,
  listCrisisSupportToolDefinitions,
} from "./crisis-support-tools.js";
import type { AgentAutomationService } from "../agent-automation.js";

export type SessionCompactionResult = {
  summary: string;
  beforeChars: number;
  afterChars: number;
  droppedMessages: number;
  keptMessages: number;
  systemSessionId?: string;
};

export type SessionForkResult = {
  sessionId: string;
  title: string;
  sourceSessionId: string;
  /** 拷贝的事件条数（不含被跳过的 delta） */
  copiedEvents: number;
  mode: "copy";
};

/** Fork 时跳过流式碎片与瞬态快照，只留终态事件，UI/模型上下文都够用且更快 */
const FORK_SKIP_EVENT_TYPES = new Set<string>([
  "assistant_delta",
  "reasoning_delta",
  "run_log",
  "queue_update",
]);

/** Agent.configJson → cloud 配置（宽容解析） */
export function agentCloudConfig(agent: Agent): CloudAgentConfig {
  try {
    return parseCloudAgentConfig(JSON.parse(agent.configJson || "{}"));
  } catch {
    return {};
  }
}

function compactBudgetOverrides(cloud: CloudAgentConfig): Partial<CompactBudget> {
  return {
    thresholdChars: cloud.compactThresholdChars,
    softThresholdChars: cloud.compactSoftThresholdChars,
    keepRecent: cloud.compactKeepRecent,
    keepRecentChars: cloud.compactKeepRecentChars,
    maxToolResultChars: cloud.maxToolResultChars,
  };
}

/**
 * 子代理默认最大嵌套深度：主循环派生的子代理（depth 1）还可以再派生一层（depth 2）。
 * 可经 cloud.maxSubagentDepth 调整（1-5）；达到该深度的子代理不再拥有派生工具。
 */
const SUBAGENT_MAX_DEPTH_DEFAULT = 2;

export type CloudAgentRuntimeDeps = {
  store: CloudAgentSessionStore;
  gateway: McpGateway;
  modelRouter: ModelRouterService;
  agentService: AgentService;
  /** 自动记忆依赖（可选；缺省时禁用自动记忆） */
  memoryStore?: MemoryStore | null;
  memoryProviders?: MemoryProvidersService | null;
  /** 工作区文件系统（可选；缺省时图片附件仅以文本注记传给模型） */
  workspaceFsProvider?: WorkspaceFsProvider | null;
  /** 技能服务（可选；缺省时不注入技能摘要） */
  skills?: import("../skills/service.js").SkillsService | null;
  /** Agent hooks（可选；缺省时不触发插件 hooks） */
  agentHooks?: import("../agent-hooks.js").AgentHooksService | null;
  /** 远程 Chat SDK 通道工具（可选；远程会话注入 chat_* 发帖/回帖工具） */
  remoteChannels?: import("../remote-channel-tools.js").RemoteChannelToolPort | null;
  /** 定时任务自动化（可选；主 chat 注入 schedule 工具） */
  automation?: AgentAutomationService | null;
};

export class CloudAgentRuntime {
  /** 同会话压缩串行，避免并发写多个 context_compacted */
  private readonly compactLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CloudAgentRuntimeDeps) {}

  private get store() {
    return this.deps.store;
  }

  private get loopDeps(): AgentLoopDeps {
    return {
      store: this.deps.store,
      modelRouter: this.deps.modelRouter,
      gateway: this.deps.gateway,
    };
  }

  private async withCompactLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.compactLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    this.compactLocks.set(sessionId, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.compactLocks.get(sessionId) === tail) this.compactLocks.delete(sessionId);
    }
  }

  /**
   * 压缩预算：用户配置 + 对话模型上下文窗口感知（token→字符粗估）。
   * 解析失败时退回纯配置默认值。
   */
  private async resolveCompactBudgetForCloud(
    tenantId: string,
    cloud: CloudAgentConfig,
  ): Promise<CompactBudget> {
    const overrides = compactBudgetOverrides(cloud);
    try {
      const routeInput = cloud.modelRouteId?.trim()
        ? { capability: "chat" as const, routeId: cloud.modelRouteId.trim() }
        : cloud.model?.trim()
          ? { capability: "chat" as const, alias: cloud.model.trim() }
          : { capability: "chat" as const };
      const route = await this.deps.modelRouter.resolveRoute(tenantId, routeInput);
      const limit =
        typeof route?.meta?.contextLimit === "number" && route.meta.contextLimit > 0
          ? route.meta.contextLimit
          : null;
      return resolveCompactBudgetForContextWindow(overrides, limit);
    } catch {
      return resolveCompactBudget(overrides);
    }
  }

  /** 主对话 / 子代理 / 委派共用的循环内压缩钩子 */
  private makeCompactInLoopHook(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    budget: CompactBudget;
    parentTitle?: string;
  }): NonNullable<AgentLoopHooks["compactInLoop"]> {
    return (msgs, reason) =>
      this.compactMessagesInPlace({
        tenantId: input.tenantId,
        agent: input.agent,
        sessionId: input.sessionId,
        runId: input.runId,
        cloud: input.cloud,
        messages: msgs,
        budget: input.budget,
        parentTitle: input.parentTitle,
        source: reason === "overflow" ? "overflow" : "auto",
      });
  }

  /**
   * 定时任务 / 心跳触发：新建 system 会话并异步 startTurn。
   * 返回后 Run 在后台继续，调用方可记录 sessionId/runId。
   */
  async startAutomationTurn(input: {
    tenantId: string;
    agentId: string;
    prompt: string;
    title: string;
    kind: "schedule" | "heartbeat";
    scheduleId?: string;
    scheduleName?: string;
    project?: string | null;
  }): Promise<{ sessionId: string; runId: string }> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("automation prompt is empty");
    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    const session = await this.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agentId,
      title: input.title.slice(0, 80) || "定时任务",
      kind: "system",
      project: input.project ?? null,
      origin: {
        source: "system",
        callerAgentId: agent.id,
        callerAgentName: agent.name,
        platform: input.kind,
        ...(input.scheduleId ? { connectionId: input.scheduleId } : {}),
        ...(input.scheduleName ? { externalThreadKey: input.scheduleName } : {}),
      },
    });

    // 标明自动触发，避免 Agent 当成用户实时对话去追问/寒暄
    const name = input.scheduleName?.trim();
    const cwdHint = input.project
      ? `请在 ${projectDefaultWorkingDir(input.project)} 内完成，产物不要写到工作区根。`
      : "若任务会写文件，先在 /workspace/projects/<名>/ 下工作，不要写到工作区根。";
    const content =
      input.kind === "schedule"
        ? [
            `【定时任务】这是系统按计划自动触发的定时任务${name ? `「${name}」` : ""}，不是用户正在与你实时对话。`,
            "请直接执行下方任务内容，完成后简要汇报结果；不要反问「需要我做什么」或等待用户回复。",
            cwdHint,
            "",
            "## 任务内容",
            prompt,
          ].join("\n")
        : [
            "【心跳任务】这是系统自动触发的心跳检查，不是用户正在与你实时对话。",
            "请直接执行下方内容，完成后简要汇报；不要反问或等待用户回复。",
            cwdHint,
            "",
            "## 任务内容",
            prompt,
          ].join("\n");

    const { runId } = await this.startTurn({
      tenantId: input.tenantId,
      agentId: input.agentId,
      sessionId: session.id,
      content,
    });
    return { sessionId: session.id, runId };
  }

  async startTurn(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    content?: string;
    /** 分支父节点：新消息跟在哪个 Run 的回答后（null=根；缺省=线性推断） */
    parentRunId?: string | null;
    /** 重新生成：针对指定用户消息再跑一个变体（不追加新用户消息） */
    regenerateOfMessageId?: string;
    /** 重试：等价于重新生成最后一条用户消息 */
    retry?: boolean;
    /** 从上次中断（cancelled）的 Run 接着做，不展示为新用户气泡 */
    continue?: boolean;
    /** 随消息上传的附件（已在 Agent 工作区） */
    attachments?: CloudAgentAttachment[];
    /** 本次用户触发 Run 的调用时模型选项。 */
    options?: CloudAgentRunOptions;
  }): Promise<{ runId: string }> {
    const attachments = parseAttachments(input.attachments);
    const isContinue = Boolean(input.continue);
    const isRegenerate = Boolean(input.regenerateOfMessageId || input.retry);
    if (isContinue && isRegenerate) throw new Error("继续与重新生成不能同时使用");

    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    if (session.activeRunId) throw new Error("当前会话已有进行中的 Run，请先等待或取消");

    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    let content = input.content?.trim() ?? "";
    let parentRunId = input.parentRunId;
    if (isContinue) {
      const recent = await this.store.listEvents(input.sessionId, {
        afterSeq: Math.max(0, session.lastSeq - 200),
        limit: 200,
      });
      const cancelledId = lastCancelledRunId(recent);
      if (!cancelledId) throw new Error("没有可继续的中断任务");
      content = CONTINUE_TURN_PROMPT;
      parentRunId = cancelledId;
    }
    if (!isRegenerate && !content && attachments.length === 0) {
      throw new Error("消息不能为空");
    }

    let targetMessageId: string;
    if (isRegenerate) {
      if (session.lastSeq === 0) throw new Error("会话为空，无法重新生成");
      const events = await this.store.listEventsForChain(input.sessionId, { afterSeq: 0 });
      if (input.regenerateOfMessageId) {
        const found = events.some(
          (e) =>
            e.type === "user_message" &&
            (e.payload as Record<string, unknown>).messageId ===
              input.regenerateOfMessageId,
        );
        if (!found) throw new Error("目标用户消息不存在");
        targetMessageId = input.regenerateOfMessageId;
      } else {
        const lastUser = [...events]
          .reverse()
          .find((e) => e.type === "user_message");
        const mid = lastUser
          ? (lastUser.payload as Record<string, unknown>).messageId
          : null;
        if (typeof mid !== "string") throw new Error("会话中没有用户消息");
        targetMessageId = mid;
      }
    } else {
      targetMessageId = newId();
    }

    const isFirstTurn = session.lastSeq === 0;
    const run = await this.store.createRun(input.sessionId);
    if (session.createdByUserId) {
      recordUserUsage({
        tenantId: input.tenantId,
        userId: session.createdByUserId,
        category: "run",
        action: "run_started",
        agentId: input.agentId,
        sessionId: input.sessionId,
        resourceKind: "run",
        resourceId: run.id,
      });
    }

    if (!isRegenerate) {
      // 先用首条消息截断作临时标题，运行结束后再由模型润色
      if (!isContinue && isFirstTurn && session.title === "新对话") {
        const title = content.length > 40 ? `${content.slice(0, 40)}…` : content;
        await this.store.updateSession(input.tenantId, input.agentId, input.sessionId, {
          title,
        });
      }
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "user_message",
        runId: run.id,
        payload: {
          messageId: targetMessageId,
          content,
          ...(parentRunId !== undefined ? { parentRunId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(isContinue ? { continue: true } : {}),
        },
      });
    }

    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "run_start",
      runId: run.id,
      payload: {
        runId: run.id,
        replyToMessageId: targetMessageId,
        ...(input.options ? { options: input.options } : {}),
      },
    });

    // 异步执行，HTTP 立即返回；客户端通过事件流接收结果
    const actor = idsFromSession({
      userId: session.createdByUserId,
      tenantId: input.tenantId,
    });
    void withLogContext(actor, () =>
      this.executeRun({
        tenantId: input.tenantId,
        agent,
        sessionId: input.sessionId,
        runId: run.id,
        targetMessageId,
        isFirstTurn,
        ...(input.options ? { options: input.options } : {}),
      }),
    ).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        // 引擎已收尾（cancelled/completed/failed）则不重复写事件
        const current = await this.store.getRun(run.id);
        if (current && current.status !== "queued" && current.status !== "running") {
          return;
        }
        // 取消引发的异常：收尾为 cancelled 而非 failed
        if (isAbortError(err) || (await this.store.isCancelRequested(run.id))) {
          await this.store.appendEvent({
            sessionId: input.sessionId,
            type: "run_end",
            runId: run.id,
            payload: { runId: run.id, status: "cancelled" },
          });
          await this.store.finishRun(input.sessionId, run.id, "cancelled");
          // 停止只中断当前回合：排队消息继续按序发出
          void this.startNextQueued({
            tenantId: input.tenantId,
            agentId: input.agentId,
            sessionId: input.sessionId,
          });
          return;
        }
        getTelemetry().cloudAgentRuns.inc({ status: "error" });
        await failRun(this.store, input.sessionId, run.id, message);
        // Codex 式：出错结束回合后继续发下一条排队消息
        void this.startNextQueued({
          tenantId: input.tenantId,
          agentId: input.agentId,
          sessionId: input.sessionId,
        });
      } catch (e) {
        recordPlatformFault("cloud_agent.record_run_error", e, {
          subsystem: "cloud_agent",
        });
      }
    });

    return { runId: run.id };
  }

  /**
   * 后续消息入队（服务端权威队列，queue_update 快照实时同步到所有设备）：
   * - mode=steer 且有活跃 Run：loop 在下一工具批结束后注入当前回合
   * - 其余情况：当前 Run 结束后由服务端按 FIFO 逐条开新回合（一次一条）
   */
  async enqueueFollowUp(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    content?: string;
    attachments?: CloudAgentAttachment[];
    mode?: CloudAgentFollowUpMode;
  }): Promise<{ messageId: string; mode: CloudAgentFollowUpMode }> {
    const content = input.content?.trim() ?? "";
    const attachments = parseAttachments(input.attachments);
    if (!content && attachments.length === 0) throw new Error("消息不能为空");

    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    // 没有活跃 Run 时无处注入，一律按 queue 排队（随后立即出队开新回合）
    const mode: CloudAgentFollowUpMode =
      session.activeRunId && input.mode !== "queue" ? "steer" : "queue";

    const messageId = newId();
    await this.store.enqueueQueued(input.sessionId, {
      messageId,
      content,
      attachments,
      mode,
      createdAt: new Date().toISOString(),
    });
    if (!session.activeRunId) {
      void this.startNextQueued({
        tenantId: input.tenantId,
        agentId: input.agentId,
        sessionId: input.sessionId,
      });
    }
    return { messageId, mode };
  }

  /**
   * 空闲时取队头开新回合（Codex maybe_send_next_queued_input：一次只发一条）。
   * 触发点：Run 结束（完成/失败/用户停止）、入队时会话空闲、引导取消收尾后。
   * 停止运行不清队列——「停止」只中断当前回合，排队消息继续按序发出，
   * 因此队列只在有消息待执行时短暂存在。
   */
  async startNextQueued(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void> {
    try {
      for (;;) {
        const session = await this.store.getSession(
          input.tenantId,
          input.agentId,
          input.sessionId,
        );
        if (!session || session.activeRunId) return;
        // 立即发送优先于 FIFO 队头
        const taken =
          (await this.store.takeQueueNext(input.sessionId)) ??
          (await this.store.takeNextQueued(input.sessionId));
        if (!taken) return;
        // 空内容项（不应出现）：丢弃并继续看下一条
        if (!taken.content.trim() && !taken.attachments?.length) continue;
        try {
          await this.startTurn({
            tenantId: input.tenantId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            content: taken.content,
            ...(taken.attachments?.length ? { attachments: taken.attachments } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("进行中的 Run")) {
            // 竞争失败（他端刚开新回合）：放回「下一条」槽，等那轮结束后再出队
            await this.store.requeueFront(input.sessionId, taken);
            return;
          }
          // 配置类错误（如模型路由缺失）：丢弃该项避免死循环，保留后续项
          recordPlatformFault("cloud_agent.queue_drain", message, {
            subsystem: "cloud_agent",
          });
          return;
        }
        return;
      }
    } catch (err) {
      recordPlatformFault("cloud_agent.queue_next", err, { subsystem: "cloud_agent" });
    }
  }

  /**
   * 立即发送：从队列摘出该条；有活跃 Run 则取消，收尾后优先用这条开新回合。
   * 其它排队消息保持原序，不跟着插队。
   */
  async interruptWithQueued(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    messageId: string;
  }): Promise<{ ok: boolean }> {
    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    const hit = await this.store.claimQueuedForImmediate(input.sessionId, input.messageId);
    if (!hit) return { ok: false };
    if (session.activeRunId) {
      await this.store.requestCancel(input.sessionId, session.activeRunId);
    } else {
      void this.startNextQueued({
        tenantId: input.tenantId,
        agentId: input.agentId,
        sessionId: input.sessionId,
      });
    }
    return { ok: true };
  }

  private async log(
    sessionId: string,
    runId: string,
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await appendRunLog(this.store, sessionId, runId, level, message, data);
  }

  private compactionCallMessages(input: {
    tenantId: string;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    previousSummary?: string;
    previousOps?: CompactionFileOps | null;
  }): ModelChatMessage[] {
    const digest = buildCompactionDigest(input.messages, {
      previousOps: input.previousOps,
    });
    return [
      {
        role: "system",
        content: buildCompactionSystemPrompt({
          previousSummary: input.previousSummary,
          previousOps: input.previousOps,
        }),
      },
      {
        role: "user",
        content: `请根据以下对话流水与文件轨迹生成结构化摘要。\n\n${digest}`,
      },
    ];
  }

  /** 合并「旧摘要轨迹 + 本段消息抽取 + 模型输出标签」→ 写入 context_compacted.details */
  private resolveCompactionDetails(input: {
    messages: ModelChatMessage[];
    summary: string;
    previousOps?: CompactionFileOps | null;
  }): CompactionFileOps {
    return mergeFileOps(
      input.previousOps,
      extractFileOpsFromMessages(input.messages),
      parseFileOpsFromSummary(input.summary),
    );
  }

  /**
   * Run 内实时摘要压缩（执行路径的一部分）：
   * turn 边界切分 → LLM 结构化摘要 → 落库 context_compacted → 返回 recent + summary。
   * 同会话串行，避免并发压缩互相覆盖。
   */
  private async compactHistoryRealtime(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string | null;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    budget: CompactBudget;
    previousSummary?: string;
    previousOps?: CompactionFileOps | null;
    parentTitle?: string;
    /** auto=Run 内；soft=Run 后预压；manual=用户；overflow=上游超长重试 */
    source: "auto" | "manual" | "soft" | "overflow";
    /** 是否向会话广播 run_status（仅有活跃 run 时） */
    announce?: boolean;
    /** 强制压缩（忽略「older 为空」之外的阈值，用于手动） */
    force?: boolean;
  }): Promise<{
    didCompact: boolean;
    recent: ModelChatMessage[];
    summary: string;
    details: CompactionFileOps;
    systemPrefix: ModelChatMessage[];
  } | null> {
    return this.withCompactLock(input.sessionId, async () => {
      const split = splitMessagesForCompaction(input.messages, input.budget);
      if (split.older.length === 0) {
        return {
          didCompact: false,
          recent: split.recent,
          summary: input.previousSummary?.trim() ?? "",
          details: input.previousOps ?? { readFiles: [], modifiedFiles: [] },
          systemPrefix: split.systemPrefix,
        };
      }
      // 非强制时：若 recent 已够小且 older 很短，跳过
      const olderTokens = estimateMessagesTokens(split.older);
      const totalTokens = estimateMessagesTokens(input.messages);
      if (
        !input.force &&
        olderTokens < 200 &&
        totalTokens <= input.budget.thresholdTokens
      ) {
        return {
          didCompact: false,
          recent: [...split.systemPrefix, ...split.recent],
          summary: input.previousSummary?.trim() ?? "",
          details: input.previousOps ?? { readFiles: [], modifiedFiles: [] },
          systemPrefix: split.systemPrefix,
        };
      }

      const beforeTokens = totalTokens;
      const beforeChars = approxMessagesChars(input.messages);
      // 保留 overflow / soft / manual / auto，供 UI 区分
      const compactSource = input.source;

      const emitCompacting = async (
        phase: "start" | "summarizing",
        progress: number,
      ) => {
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "context_compacting",
          runId: input.runId,
          payload: {
            ...(input.runId ? { runId: input.runId } : {}),
            source: input.source,
            phase,
            progress,
            beforeChars,
            beforeTokens,
            olderMessages: split.older.length,
            keepMessages: split.recent.length,
          },
        });
      };

      // 时间线「压缩中」步骤（工具同款低调 UI）
      await emitCompacting("start", 15);
      if (input.announce && input.runId) {
        void this.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_status",
          runId: input.runId,
          payload: {
            runId: input.runId,
            status: "thinking",
            detail: "正在压缩上下文…",
          },
        });
      }
      void this.log(
        input.sessionId,
        input.runId ?? "",
        "info",
        "同步摘要压缩上下文",
        {
          older: split.older.length,
          recent: split.recent.length,
          beforeChars,
          source: input.source,
          compactModel: this.compactModelRoute(input.cloud).label,
        },
      );

      await emitCompacting("summarizing", 45);
      const startedAt = Date.now();
      let summarized: Awaited<ReturnType<typeof this.summarizeMessages>>;
      try {
        summarized = await this.summarizeMessages({
          tenantId: input.tenantId,
          cloud: input.cloud,
          messages: split.older,
          previousSummary: input.previousSummary,
          previousOps: input.previousOps,
          audit: {
            agent: input.agent,
            parentSessionId: input.sessionId,
            parentTitle: input.parentTitle || "对话",
          },
        });
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const fallbackOps = mergeFileOps(
          input.previousOps,
          extractFileOpsFromMessages(split.older),
        );
        void this.log(input.sessionId, input.runId ?? "", "warn", "摘要调用失败，已截断较早消息", {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "context_compacted",
          runId: input.runId,
          payload: {
            summary: input.previousSummary?.trim() || "（摘要生成失败，已截断较早消息）",
            source: compactSource,
            beforeChars,
            afterChars: approxMessagesChars(split.recent),
            beforeTokens,
            afterTokens: estimateMessagesTokens(split.recent),
            droppedMessages: split.older.length,
            keptMessages: split.recent.length,
            durationMs,
            failed: true,
            details: {
              readFiles: fallbackOps.readFiles,
              modifiedFiles: fallbackOps.modifiedFiles,
            },
          },
        });
        if (input.announce && input.runId) {
          void this.store.appendEvent({
            sessionId: input.sessionId,
            type: "run_status",
            runId: input.runId,
            payload: { runId: input.runId, status: "streaming" },
          });
        }
        return {
          didCompact: true,
          recent: split.recent,
          summary: input.previousSummary?.trim() ?? "",
          details: fallbackOps,
          systemPrefix: split.systemPrefix,
        };
      }
      const durationMs = Date.now() - startedAt;
      if (!summarized.summary) {
        // 摘要失败：仍按 turn 边界丢掉 older，保证可继续（无假应急散文）
        void this.log(input.sessionId, input.runId ?? "", "warn", "摘要为空，仅保留最近 turns");
        const fallbackOps = mergeFileOps(
          input.previousOps,
          extractFileOpsFromMessages(split.older),
        );
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "context_compacted",
          runId: input.runId,
          payload: {
            summary: input.previousSummary?.trim() || "（摘要生成失败，已截断较早消息）",
            source: compactSource,
            beforeChars,
            afterChars: approxMessagesChars(split.recent),
            beforeTokens,
            afterTokens: estimateMessagesTokens(split.recent),
            droppedMessages: split.older.length,
            keptMessages: split.recent.length,
            durationMs,
            model: summarized.modelLabel,
            failed: true,
            details: {
              readFiles: fallbackOps.readFiles,
              modifiedFiles: fallbackOps.modifiedFiles,
            },
          },
        });
        if (input.announce && input.runId) {
          void this.store.appendEvent({
            sessionId: input.sessionId,
            type: "run_status",
            runId: input.runId,
            payload: { runId: input.runId, status: "streaming" },
          });
        }
        return {
          didCompact: true,
          recent: split.recent,
          summary: input.previousSummary?.trim() ?? "",
          details: fallbackOps,
          systemPrefix: split.systemPrefix,
        };
      }

      const afterTokens =
        estimateMessagesTokens(split.recent) +
        estimateMessagesTokens([{ role: "system", content: summarized.summary }]);
      const afterChars =
        approxMessagesChars(split.recent) + summarized.summary.length + 120;
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "context_compacted",
        runId: input.runId,
        payload: {
          summary: summarized.summary,
          source: compactSource,
          beforeChars,
          afterChars,
          beforeTokens,
          afterTokens,
          droppedMessages: split.older.length,
          keptMessages: split.recent.length,
          systemSessionId: summarized.systemSessionId,
          durationMs,
          model: summarized.modelLabel,
          details: {
            readFiles: summarized.details.readFiles,
            modifiedFiles: summarized.details.modifiedFiles,
          },
        },
      });
      if (input.announce && input.runId) {
        void this.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_status",
          runId: input.runId,
          payload: { runId: input.runId, status: "streaming" },
        });
      }
      void this.log(input.sessionId, input.runId ?? "", "info", "同步摘要已完成", {
        summaryChars: summarized.summary.length,
        readFiles: summarized.details.readFiles.length,
        modifiedFiles: summarized.details.modifiedFiles.length,
        durationMs,
        model: summarized.modelLabel,
      });

      return {
        didCompact: true,
        recent: split.recent,
        summary: summarized.summary,
        details: summarized.details,
        systemPrefix: split.systemPrefix,
      };
    });
  }

  /**
   * 循环内/溢出时：就地改写 messages = systemPrefix + 摘要 system + recent。
   */
  private async compactMessagesInPlace(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    budget: CompactBudget;
    parentTitle?: string;
    source?: "auto" | "overflow";
  }): Promise<boolean> {
    const last = await this.store.getLastCompaction(input.sessionId);
    const payload = (last?.payload ?? {}) as Record<string, unknown>;
    const previousSummary =
      typeof payload.summary === "string" ? payload.summary : "";
    const previousOps = fileOpsFromCompactionPayload(payload);

    const result = await this.compactHistoryRealtime({
      tenantId: input.tenantId,
      agent: input.agent,
      sessionId: input.sessionId,
      runId: input.runId,
      cloud: input.cloud,
      messages: input.messages,
      budget: input.budget,
      previousSummary,
      previousOps,
      parentTitle: input.parentTitle,
      source: input.source ?? "auto",
      announce: true,
    });
    if (!result?.didCompact) return false;

    const summaryBlock = result.summary
      ? formatHistorySummaryForPrompt(result.summary, result.details)
      : "";
    const next: ModelChatMessage[] = [...result.systemPrefix];
    if (summaryBlock) {
      next.push({
        role: "system",
        content: `# 早前对话摘要（压缩检查点）\n${summaryBlock}`,
      });
    }
    next.push(...result.recent);
    // 就地替换，保持 loop 持有的同一数组引用
    input.messages.length = 0;
    input.messages.push(...next);
    prepareHistoryForModel(input.messages, input.budget);
    return true;
  }

  /** 压缩路由：compactModel(Route) → 对话 model(Route) → 租户默认 */
  private compactModelRoute(cloud: CloudAgentConfig): {
    capability: "chat";
    routeId?: string;
    alias?: string;
    label: string;
  } {
    if (cloud.compactModelRouteId?.trim()) {
      return {
        capability: "chat",
        routeId: cloud.compactModelRouteId.trim(),
        label: cloud.compactModel?.trim() || cloud.compactModelRouteId.trim(),
      };
    }
    if (cloud.compactModel?.trim()) {
      return {
        capability: "chat",
        alias: cloud.compactModel.trim(),
        label: cloud.compactModel.trim(),
      };
    }
    if (cloud.modelRouteId?.trim()) {
      return {
        capability: "chat",
        routeId: cloud.modelRouteId.trim(),
        label: cloud.model?.trim() || cloud.modelRouteId.trim(),
      };
    }
    if (cloud.model?.trim()) {
      return {
        capability: "chat",
        alias: cloud.model.trim(),
        label: cloud.model.trim(),
      };
    }
    return { capability: "chat", label: "default" };
  }

  private async summarizeMessages(input: {
    tenantId: string;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    previousSummary?: string;
    previousOps?: CompactionFileOps | null;
    audit?: {
      agent: Agent;
      parentSessionId: string;
      parentTitle: string;
    };
  }): Promise<{
    summary: string;
    systemSessionId?: string;
    details: CompactionFileOps;
    modelLabel: string;
  }> {
    const messages = this.compactionCallMessages(input);
    const resolved = this.compactModelRoute(input.cloud);
    const route = {
      capability: "chat" as const,
      ...(resolved.routeId
        ? { routeId: resolved.routeId }
        : resolved.alias
          ? { alias: resolved.alias }
          : {}),
    };
    let audit:
      | {
          sessionId: string;
          runId: string;
          messageId: string;
        }
      | undefined;

    if (input.audit) {
      const systemSession = await this.store.createSession({
        tenantId: input.tenantId,
        agentId: input.audit.agent.id,
        title: `上下文压缩：${input.audit.parentTitle.slice(0, 32)}${
          input.audit.parentTitle.length > 32 ? "…" : ""
        }`,
        kind: "system",
        origin: {
          source: "system",
          parentSessionId: input.audit.parentSessionId,
          callerAgentId: input.audit.agent.id,
          callerAgentName: input.audit.agent.name,
        },
      });
      const run = await this.store.createRun(systemSession.id);
      await this.store.markRunStarted(run.id);
      audit = { sessionId: systemSession.id, runId: run.id, messageId: newId() };
      await this.store.appendEvent({
        sessionId: audit.sessionId,
        type: "user_message",
        runId: audit.runId,
        payload: {
          messageId: audit.messageId,
          content: JSON.stringify([input.tenantId, messages, route], null, 2),
          parentRunId: null,
        },
      });
      await this.store.appendEvent({
        sessionId: audit.sessionId,
        type: "run_start",
        runId: audit.runId,
        payload: { runId: audit.runId, replyToMessageId: audit.messageId },
      });
    }

    try {
      const sum = await this.deps.modelRouter.chat(input.tenantId, messages, route);
      const summary = (sum.content ?? "").trim();
      const details = this.resolveCompactionDetails({
        messages: input.messages,
        summary,
        previousOps: input.previousOps,
      });
      if (audit) {
        await this.store.appendEvent({
          sessionId: audit.sessionId,
          type: "assistant_message",
          runId: audit.runId,
          payload: { messageId: newId(), content: JSON.stringify(sum, null, 2) },
        });
        await this.store.appendEvent({
          sessionId: audit.sessionId,
          type: "run_end",
          runId: audit.runId,
          payload: { runId: audit.runId, status: "completed" },
        });
        await this.store.finishRun(audit.sessionId, audit.runId, "completed");
      }
      return {
        summary,
        systemSessionId: audit?.sessionId,
        details,
        modelLabel: resolved.label,
      };
    } catch (err) {
      if (audit) {
        const message = err instanceof Error ? err.message : String(err);
        await failRun(this.store, audit.sessionId, audit.runId, message);
      }
      throw err;
    }
  }

  async compactSession(input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
  }): Promise<SessionCompactionResult> {
    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    if (session.activeRunId) throw new Error("当前会话正在运行，请结束后再压缩");
    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");
    const cloud = agentCloudConfig(agent);

    const lastCompaction = await this.store.getLastCompaction(input.sessionId);
    const lastCompactionSeq = lastCompaction?.seq ?? 0;
    const lastPayload = (lastCompaction?.payload ?? {}) as Record<string, unknown>;
    const previousSummary =
      typeof lastPayload.summary === "string" ? lastPayload.summary : "";
    const previousOps = fileOpsFromCompactionPayload(lastPayload);

    // 与 executeRun 相同投影：压缩点之后的全部事件
    const history = await this.store.listEventsForChain(input.sessionId, {
      afterSeq: lastCompactionSeq,
    });
    const lastUser = [...history].reverse().find((e) => e.type === "user_message");
    const targetMessageId = lastUser
      ? (lastUser.payload as Record<string, unknown>).messageId
      : null;
    const targetId =
      typeof targetMessageId === "string"
        ? targetMessageId
        : (() => {
            throw new Error("会话中没有可压缩的消息");
          })();

    const canUsePreviousSummary = Boolean(previousSummary);
    const chainRes = buildChainMessages(
      history.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      targetId,
    );
    const allMessages = chainRes.messages;
    const budget = await this.resolveCompactBudgetForCloud(input.tenantId, cloud);
    prepareHistoryForModel(allMessages, budget);
    const beforeChars = approxMessagesChars(allMessages);
    const newerUserMessages = history.filter((e) => e.type === "user_message").length;
    const newerAssistantMessages = history.filter(
      (e) => e.type === "assistant_message",
    ).length;
    const split = splitMessagesForCompaction(allMessages, budget);
    if (split.older.length === 0 && !previousSummary) {
      throw new Error("当前会话还不需要压缩");
    }
    if (lastCompactionSeq > 0 && newerUserMessages + newerAssistantMessages < 2) {
      throw new Error("上次压缩后新增内容太少");
    }

    // 优先挂到该用户消息最近一次回答的 Run，避免新建空变体；无则新建短 Run
    const lastReplyRun = [...history].reverse().find((e) => {
      if (e.type !== "run_start" || !e.runId) return false;
      const reply = (e.payload as Record<string, unknown>).replyToMessageId;
      return reply === targetId;
    });
    let attachRunId = lastReplyRun?.runId ?? null;
    let ownsRun = false;
    if (!attachRunId) {
      const run = await this.store.createRun(input.sessionId);
      await this.store.markRunStarted(run.id);
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "run_start",
        runId: run.id,
        payload: { runId: run.id, replyToMessageId: targetId },
      });
      attachRunId = run.id;
      ownsRun = true;
    }

    try {
      const compacted = await this.compactHistoryRealtime({
        tenantId: input.tenantId,
        agent,
        sessionId: input.sessionId,
        runId: attachRunId,
        cloud,
        messages: allMessages,
        budget,
        previousSummary: canUsePreviousSummary ? previousSummary : undefined,
        previousOps: canUsePreviousSummary ? previousOps : undefined,
        parentTitle: session.title,
        source: "manual",
        force: true,
        announce: ownsRun,
      });
      if (!compacted?.summary) throw new Error("摘要为空，请稍后重试");

      const result: SessionCompactionResult = {
        summary: compacted.summary,
        beforeChars,
        afterChars: approxMessagesChars(compacted.recent) + compacted.summary.length + 80,
        droppedMessages: split.older.length,
        keptMessages: compacted.recent.length,
      };
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "context_sources",
        runId: attachRunId,
        payload: {
          runId: attachRunId,
          items: [{ kind: "summary", title: "对话压缩摘要", content: compacted.summary }],
        },
      });
      if (ownsRun) {
        await this.store.appendEvent({
          sessionId: input.sessionId,
          type: "run_end",
          runId: attachRunId,
          payload: { runId: attachRunId, status: "completed" },
        });
        await this.store.finishRun(input.sessionId, attachRunId, "completed");
      }
      return result;
    } catch (err) {
      if (ownsRun) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await failRun(this.store, input.sessionId, attachRunId, message);
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  /**
   * 从已有会话派生新会话：写入压缩摘要作为「早前对话」上下文，
   * 用户在新会话发首条消息即可续聊。原始会话事件不改动。
   */
  async forkSession(input: {
    tenantId: string;
    agentId: string;
    sourceSessionId: string;
    title?: string;
    createdByUserId?: string | null;
  }): Promise<SessionForkResult> {
    const source = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sourceSessionId,
    );
    if (!source) throw new Error("源会话不存在");
    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    // 直接拷贝终态事件：保留 messageId/runId，UI 可见历史，编辑/重生可继续；无 LLM 摘要
    const history = await this.store.listEvents(input.sourceSessionId, { limit: 2000 });
    const toCopy = history.filter((ev) => !FORK_SKIP_EVENT_TYPES.has(ev.type));

    const title =
      input.title?.trim() ||
      `续：${source.title}`.slice(0, 80);

    const created = await this.store.createSession({
      tenantId: input.tenantId,
      agentId: input.agentId,
      title,
      createdByUserId: input.createdByUserId ?? null,
      kind: "chat",
      origin: {
        source: "api",
        parentSessionId: input.sourceSessionId,
        callerAgentId: agent.id,
        callerAgentName: agent.name,
      },
      model: source.model,
      modelRouteId: source.modelRouteId,
      reasoning: source.reasoning,
      project: source.project,
    });

    const copiedEvents = await this.store.appendEventsBulk(
      created.id,
      toCopy.map((ev) => ({
        type: ev.type,
        runId: ev.runId,
        payload: ev.payload,
      })),
    );

    return {
      sessionId: created.id,
      title: created.title,
      sourceSessionId: input.sourceSessionId,
      copiedEvents,
      mode: "copy",
    };
  }

  private async executeRun(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    targetMessageId: string;
    isFirstTurn: boolean;
    options?: CloudAgentRunOptions;
  }): Promise<void> {
    const { tenantId, agent, sessionId, runId } = input;
    await this.store.markRunStarted(runId);

    const sessionPreferences = await this.store.getSession(tenantId, agent.id, sessionId);
    // 预热 Redis seq + 元数据，避免首个 reasoning_delta 再查库
    await this.store.warmSession(
      sessionId,
      sessionPreferences
        ? {
            tenantId: sessionPreferences.tenantId,
            agentId: sessionPreferences.agentId,
            lastSeq: sessionPreferences.lastSeq,
          }
        : undefined,
    );

    const cloud = {
      ...agentCloudConfig(agent),
      ...(sessionPreferences?.model ? { model: sessionPreferences.model } : {}),
      ...(sessionPreferences?.modelRouteId
        ? { modelRouteId: sessionPreferences.modelRouteId }
        : sessionPreferences?.model
          ? { modelRouteId: undefined }
          : {}),
    } satisfies CloudAgentConfig;
    const enableTools = cloud.enableTools !== false;

    // 尽早让 UI 进入 thinking，不等后面的准备
    void this.store.appendEvent({
      sessionId,
      type: "run_status",
      runId,
      payload: { runId, status: "thinking" },
    });

    // OpenCode / Memoh 式投影：
    // 模型上下文 = 最近 context_compacted 检查点之后的全部 durable 事件（+ 摘要进 system）；
    // Redis 热环只服务 SSE，不参与投影；体积用字符预算管理，不用事件条数窗。
    const lastCompaction = await this.store.getLastCompaction(sessionId);
    const lastCompactionSeq = lastCompaction?.seq ?? 0;
    const lastCompactionPayload = (lastCompaction?.payload ?? {}) as Record<string, unknown>;
    const compactedSummary =
      typeof lastCompactionPayload.summary === "string" ? lastCompactionPayload.summary : "";
    const previousFileOps = fileOpsFromCompactionPayload(lastCompactionPayload);

    let history = await this.store.listEventsForChain(sessionId, {
      afterSeq: lastCompactionSeq,
    });
    const targetInHistory = history.some(
      (e) =>
        e.type === "user_message" &&
        (e.payload as Record<string, unknown>).messageId === input.targetMessageId,
    );
    // 目标在压缩点之前（例如 regenerate 旧消息）：拉全量，不用摘要
    let historySummary = "";
    let historySummaryOps: CompactionFileOps | null = null;
    if (targetInHistory && compactedSummary) {
      historySummary = formatHistorySummaryForPrompt(compactedSummary, previousFileOps);
      historySummaryOps = previousFileOps;
    } else if (!targetInHistory) {
      history = await this.store.listEventsForChain(sessionId, { afterSeq: 0 });
    }

    // 沿分支链重建上下文：重新生成的旧变体与其他分支不进入模型输入
    const chainRes = buildChainMessages(
      history.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      input.targetMessageId,
    );
    let historyMsgs = chainRes.messages;
    const lastUserContent = chainRes.userContent;
    const budget = await this.resolveCompactBudgetForCloud(tenantId, cloud);
    // 进入模型前：先封顶/分级压缩过长工具结果（不丢 user/assistant 结论）
    const preCompacted = prepareHistoryForModel(historyMsgs, budget);
    if (preCompacted > 0) {
      void this.log(sessionId, runId, "info", "历史工具结果已按预算压缩", {
        compacted: preCompacted,
      });
    }

    const sourceItems: CloudAgentContextSourceItem[] = [];
    if (historySummary) {
      sourceItems.push({
        kind: "summary",
        title: "对话压缩摘要",
        content: historySummary,
      });
      if (historySummaryOps) {
        for (const p of historySummaryOps.modifiedFiles.slice(0, 12)) {
          sourceItems.push({ kind: "file", title: `已改 · ${p}`, path: p });
        }
      }
    }

    // 实时摘要：超 token 硬阈值时作为 Run 的一部分同步压缩
    const autoCompactOn = cloud.autoCompact !== false;
    const overHard = isOverHardBudget(historyMsgs, budget);
    if (overHard && autoCompactOn) {
      try {
        const compacted = await this.compactHistoryRealtime({
          tenantId,
          agent,
          sessionId,
          runId,
          cloud,
          messages: historyMsgs,
          budget,
          previousSummary: compactedSummary,
          previousOps: previousFileOps,
          parentTitle: sessionPreferences?.title,
          source: "auto",
          announce: true,
        });
        if (compacted?.didCompact) {
          historyMsgs = compacted.recent;
          prepareHistoryForModel(historyMsgs, budget);
          if (compacted.summary) {
            historySummary = formatHistorySummaryForPrompt(
              compacted.summary,
              compacted.details,
            );
            historySummaryOps = compacted.details;
            // 更新 sourceItems 中的摘要
            const sumIdx = sourceItems.findIndex((s) => s.kind === "summary");
            const item = {
              kind: "summary" as const,
              title: "对话压缩摘要",
              content: historySummary,
            };
            if (sumIdx >= 0) sourceItems[sumIdx] = item;
            else sourceItems.unshift(item);
          }
        }
      } catch (err) {
        // 摘要失败：仍按 turn 边界只保留 recent，保证能继续跑
        const split = splitMessagesForCompaction(historyMsgs, budget);
        if (split.older.length > 0) {
          historyMsgs = split.recent;
          prepareHistoryForModel(historyMsgs, budget);
        }
        void this.log(sessionId, runId, "warn", "同步摘要失败，已按 turn 边界保留最近上下文", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (overHard && !autoCompactOn) {
      const split = splitMessagesForCompaction(historyMsgs, budget);
      if (split.older.length > 0) {
        historyMsgs = split.recent;
        prepareHistoryForModel(historyMsgs, budget);
        void this.log(sessionId, runId, "info", "autoCompact 关闭：仅按 turn 边界截断历史", {
          dropped: split.older.length,
          kept: split.recent.length,
        });
      }
    }

    const remoteHandle = this.deps.remoteChannels?.get(sessionId) ?? undefined;
    const sessionKind = sessionPreferences?.kind ?? "chat";

    // —— 记忆 / 工具 / 技能 / hooks ——
    // ponytail: 记忆召回（含 embedding）可拖到秒级，首字路径设 80ms 超时；未完成则空记忆开流
    const autoMemoryOn =
      agent.enableMemory &&
      cloud.autoMemory !== false &&
      Boolean(this.deps.memoryProviders);

    const memoryPromise = (async (): Promise<{
      text: string;
      items: CloudAgentContextSourceItem[];
      resolved: ResolvedMemory | null;
    }> => {
      if (!autoMemoryOn) return { text: "", items: [], resolved: null };
      try {
        const resolvedMemory = await resolveAgentMemory(this.deps.memoryProviders!, agent);
        if (!resolvedMemory) return { text: "", items: [], resolved: null };
        const ctx = await buildMemoryContext(
          this.deps.memoryStore ?? null,
          resolvedMemory,
          agent,
          lastUserContent || undefined,
        );
        if (ctx.count <= 0) return { text: "", items: [], resolved: resolvedMemory };
        void this.log(sessionId, runId, "info", `记忆召回 ${ctx.count} 条`, {
          retrievalMode: ctx.retrievalMode,
        });
        return {
          text: ctx.text,
          resolved: resolvedMemory,
          items: ctx.items.map((m) => ({
            kind: "memory" as const,
            title: m.layer ? `记忆 · ${m.layer}` : "记忆",
            content: m.content,
            ...(m.id ? { id: m.id } : {}),
            ...(m.layer ? { layer: m.layer } : {}),
          })),
        };
      } catch (err) {
        void this.log(sessionId, runId, "warn", "记忆召回失败", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { text: "", items: [], resolved: null };
      }
    })();

    const toolsPromise = (async () => {
      let definitions: ModelToolDefinition[] = [];
      let nameMap = new Map<string, string>();
      let peerAgents: Agent[] = [];
      let peerAgentsDesc = "";
      if (!enableTools) {
        return { definitions, nameMap, peerAgents, peerAgentsDesc };
      }
      // 用户在 Composer 的连接器面板里关掉的工具：本回合不进模型
      // （危机支持工具不受影响，始终保留）
      const disabled = new Set(input.options?.disabledTools ?? []);
      const allow = (name: string) => !disabled.has(name);
      const tools = (await this.deps.gateway.listToolsForAgent(agent)).filter((t) =>
        allow(t.qualifiedName),
      );
      const mapped = toolsToDefinitions(tools);
      definitions = mapped.definitions;
      nameMap = mapped.nameMap;

      if (remoteHandle) {
        for (const def of listRemoteChannelToolDefinitions(remoteHandle)) {
          if (definitions.some((d) => d.function.name === def.function.name)) continue;
          definitions.push(def);
          nameMap.set(def.function.name, def.function.name);
        }
      }

      if (sessionKind === "chat") {
        for (const def of listSessionToolDefinitions()) {
          if (!allow(def.function.name)) continue;
          if (definitions.some((d) => d.function.name === def.function.name)) continue;
          definitions.push(def);
          nameMap.set(def.function.name, def.function.name);
        }
        if (this.deps.automation) {
          for (const def of listAutomationToolDefinitions()) {
            if (!allow(def.function.name)) continue;
            if (definitions.some((d) => d.function.name === def.function.name)) continue;
            definitions.push(def);
            nameMap.set(def.function.name, def.function.name);
          }
        }
      }

      for (const def of listCrisisSupportToolDefinitions()) {
        if (definitions.some((d) => d.function.name === def.function.name)) continue;
        definitions.push(def);
        nameMap.set(def.function.name, def.function.name);
      }

      try {
        peerAgents = (await this.deps.agentService.list(tenantId)).filter(
          (a) => a.id !== agent.id,
        );
      } catch {
        peerAgents = [];
      }
      if (peerAgents.length > 0 && allow(DELEGATE_TOOL_NAME)) {
        peerAgentsDesc = peerAgents
          .slice(0, 20)
          .map((a) => `- ${a.slug}（${a.name}）`)
          .join("\n");
        definitions.push({
          type: "function",
          function: {
            name: DELEGATE_TOOL_NAME,
            description:
              "Delegate a self-contained subtask to another agent in the same tenant (it has its own tools and memory). Blocks until that agent returns a final answer. Use when you need that agent's specialized capability or a clear division of labor.",
            parameters: {
              type: "object",
              properties: {
                agentSlug: {
                  type: "string",
                  description: `Target agent slug. Options: ${peerAgents
                    .slice(0, 20)
                    .map((a) => a.slug)
                    .join(", ")}`,
                },
                task: {
                  type: "string",
                  description: "Self-contained task description for the other agent",
                },
                context: {
                  type: "string",
                  description:
                    "Optional extra context (the other agent cannot see this conversation history)",
                },
              },
              required: ["agentSlug", "task"],
            },
          },
        });
      }
      return { definitions, nameMap, peerAgents, peerAgentsDesc };
    })();

    const skillsPromise = this.deps.skills
      ? this.deps.skills.promptSummary(tenantId, agent.id)
      : Promise.resolve("");

    const emptyProjectCtx: LoadedProjectContext = {
      skillsSummary: "",
      skills: [],
      hookPackages: [],
    };
    const projectCtxPromise = sessionPreferences?.project
      ? this.loadProjectContext(agent, sessionPreferences.project)
      : Promise.resolve(emptyProjectCtx);
    const projectHookOpts = async () => {
      const ctx = await projectCtxPromise;
      const slug = sessionPreferences?.project;
      return {
        extraPackages: ctx.hookPackages,
        sessionId,
        ...(slug ? { workingDir: projectDefaultWorkingDir(slug) } : {}),
      };
    };

    const hooksPromise = (async (): Promise<ModelChatMessage[]> => {
      const hooksSvc = this.deps.agentHooks;
      if (!hooksSvc) return [];
      const extra: ModelChatMessage[] = [];
      const hookOpts = await projectHookOpts();
      try {
        if (input.isFirstTurn) {
          const startResults = await hooksSvc.runEvent(agent, "SessionStart", hookOpts);
          const inject = collectInjectText(startResults);
          if (inject) {
            extra.push({
              role: "system",
              content: `# Hooks · SessionStart\n${inject}`,
            });
          }
        }
        const promptResults = await hooksSvc.runEvent(agent, "UserPromptSubmit", {
          userPrompt: lastUserContent,
          ...hookOpts,
        });
        const promptInject = collectInjectText(promptResults);
        const promptDeny = firstDeny(promptResults);
        if (promptInject || promptDeny?.reason) {
          extra.push({
            role: "system",
            content: `# Hooks · UserPromptSubmit\n${[promptInject, promptDeny?.reason].filter(Boolean).join("\n\n")}`,
          });
        }
        if (extra.length) {
          void this.log(sessionId, runId, "info", "hooks 已注入上下文", {
            events: extra.map((m) => (m.content ?? "").split("\n")[0]),
            packages: hookOpts.extraPackages?.length ?? 0,
          });
        }
      } catch (err) {
        void this.log(sessionId, runId, "warn", "hooks 执行失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return extra;
    })();

    const memoryWithBudget = Promise.race([
      memoryPromise,
      new Promise<{
        text: string;
        items: CloudAgentContextSourceItem[];
        resolved: ResolvedMemory | null;
      }>((resolve) =>
        setTimeout(() => resolve({ text: "", items: [], resolved: null }), 80),
      ),
    ]);

    const [memoryBag, toolsBag, skillsSummary, hookMsgs, projectCtx] = await Promise.all([
      memoryWithBudget,
      toolsPromise,
      skillsPromise,
      hooksPromise,
      projectCtxPromise,
    ]);

    const memoryContext = memoryBag.text;
    // postRun：若记忆超时未进 system，仍用完整召回结果写记忆
    const resolvedMemoryPromise = memoryPromise.then((m) => m.resolved);
    const resolvedMemory = memoryBag.resolved;
    sourceItems.push(...memoryBag.items);
    const { definitions, nameMap, peerAgents, peerAgentsDesc } = toolsBag;

    if (sourceItems.length > 0) {
      void this.store
        .appendEvent({
          sessionId,
          type: "context_sources",
          runId,
          payload: { runId, items: sourceItems },
        })
        .catch((err) =>
          recordPlatformFault("cloud_agent.context_sources", err, {
            subsystem: "cloud_agent",
          }),
        );
    }

    const mergedSkills = [skillsSummary, projectCtx.skillsSummary].filter(Boolean).join("\n");
    const projectHookRunOpts = {
      extraPackages: projectCtx.hookPackages,
      sessionId,
      ...(sessionPreferences?.project
        ? { workingDir: projectDefaultWorkingDir(sessionPreferences.project) }
        : {}),
    };
    const hookFns = this.makeHookLoopFns(agent, projectHookRunOpts);
    const hasSubagent = definitions.some(
      (d) => d.function.name === SUBAGENT_TOOL_QUALIFIED,
    );
    const systemPrompt = buildSystemPrompt(agent, cloud, {
      memoryContext: memoryContext || undefined,
      historySummary: historySummary || undefined,
      peerAgents: peerAgentsDesc || undefined,
      subagents: hasSubagent,
      skills: mergedSkills || undefined,
      requestedSkills: input.options?.skills,
      remoteChannel: remoteHandle ? remoteChannelPromptBlock(remoteHandle) : undefined,
      project: sessionPreferences?.project ?? null,
      projectInstructions: projectCtx.instructions,
    });
    const messages: ModelChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...hookMsgs.filter((m) => (m.content ?? "").includes("SessionStart")),
      ...historyMsgs,
      ...hookMsgs.filter((m) => (m.content ?? "").includes("UserPromptSubmit")),
    ];

    // 图片附件：读工作区文件转 data URI（多模态输入）
    await this.resolveWorkspaceImages(agent, messages);

    void this.log(sessionId, runId, "info", "Run 开始", {
      model: cloud.model ?? "(默认路由)",
      tools: definitions.length,
      historyMessages: historyMsgs.length,
      memoryInjected: Boolean(memoryContext),
    });

    const defaultWorkingDir = sessionPreferences?.project
      ? projectDefaultWorkingDir(sessionPreferences.project)
      : undefined;
    const result = await runAgentLoop(this.loopDeps, {
      tenantId,
      agent,
      cloud,
      sessionId,
      runId,
      messages,
      definitions,
      nameMap,
      compactBudget: budget,
      beforeModelRound: (msgs) => this.resolveWorkspaceImages(agent, msgs),
      ...(defaultWorkingDir ? { defaultWorkingDir } : {}),
      ...(sessionPreferences?.project ? { projectSlug: sessionPreferences.project } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(cloud.maxToolRounds != null ? { maxRounds: cloud.maxToolRounds } : {}),
      hooks: {
        ...(autoCompactOn
          ? {
              compactInLoop: this.wrapCompactHook(
                agent,
                this.makeCompactInLoopHook({
                  tenantId,
                  agent,
                  sessionId,
                  runId,
                  cloud,
                  budget,
                  parentTitle: sessionPreferences?.title,
                }),
                projectHookRunOpts,
              ),
            }
          : {}),
        toolTitle: (modelName) => {
          if (modelName === DELEGATE_TOOL_NAME) return "委派 Agent";
          if (isSessionToolName(modelName)) {
            if (modelName === "list_chat_sessions") return "列出会话";
            if (modelName === "search_chat_sessions") return "搜索会话";
            if (modelName === "get_chat_messages") return "读取会话";
            if (modelName === "import_session_context") return "导入会话上下文";
            return "会话工具";
          }
          if (isAutomationToolName(modelName)) {
            if (modelName.includes("schedule")) return "定时任务";
            return "自动化";
          }
          if (isRemoteChannelToolName(modelName)) {
            if (modelName === "chat_post_message") return "发帖/回帖";
            if (modelName === "chat_post_channel_message") return "频道发帖";
            if (modelName === "chat_send_direct_message") return "发私信";
            if (modelName === "chat_add_reaction") return "添加反应";
            if (modelName === "chat_start_typing") return "正在输入";
            return "远程通道";
          }
          return undefined;
        },
        preResolveCalls: this.spawnSubagentsHook({
          tenantId,
          agent,
          nameMap,
          childDepth: 1,
          parentSessionId: sessionId,
          parentRunId: runId,
          isCancelled: () => this.store.isCancelRequested(runId),
          project: sessionPreferences?.project ?? null,
        }),
        // 远程通道 / 跨 Agent 委派 / 会话复用 + 插件 PreToolUse
        interceptCall: async (call, args) => {
          const hooked = await hookFns.interceptCall?.(call, args);
          if (hooked) return hooked;
          if (isCrisisSupportToolName(call.function.name)) {
            const out = await callCrisisSupportTool(this.store, agent, sessionId);
            return {
              result: {
                content: [{ type: "text", text: out.text }],
                isError: out.isError === true,
              },
            };
          }
          if (isSessionToolName(call.function.name)) {
            const out = await callSessionTool(
              this.store,
              agent,
              call.function.name,
              args,
              sessionId,
            );
            return {
              result: {
                content: [{ type: "text", text: out.text }],
                isError: out.isError === true,
              },
            };
          }
          if (isAutomationToolName(call.function.name)) {
            if (!this.deps.automation) {
              return {
                result: {
                  content: [{ type: "text", text: "自动化服务未启用" }],
                  isError: true,
                },
              };
            }
            const out = await callAutomationTool(
              this.deps.automation,
              agent,
              call.function.name,
              args,
              { defaultProject: sessionPreferences?.project ?? null },
            );
            return {
              result: {
                content: [{ type: "text", text: out.text }],
                isError: out.isError === true,
              },
            };
          }
          if (isRemoteChannelToolName(call.function.name)) {
            const handle = this.deps.remoteChannels?.get(sessionId);
            if (!handle) {
              return {
                result: {
                  content: [{ type: "text", text: "远程通道会话未绑定，无法发帖" }],
                  isError: true,
                },
              };
            }
            return { result: await callRemoteChannelTool(handle, call.function.name, args) };
          }
          if (call.function.name !== DELEGATE_TOOL_NAME) return undefined;
          const res = await this.delegateToAgent(tenantId, agent, peerAgents, args, {
            isCancelled: () => this.store.isCancelRequested(runId),
            origin: {
              parentSessionId: sessionId,
              parentRunId: runId,
              parentToolCallId: call.id,
            },
          });
          return {
            result: { content: [{ type: "text", text: res.text }] },
            link: { sessionId: res.sessionId, agentId: res.agentId },
          };
        },
        afterToolCall: hookFns.afterToolCall,
      },
    });

    if (result.status === "cancelled") {
      // 停止只中断当前回合：引导项/排队消息在取消收尾后继续按序发出
      void this.startNextQueued({ tenantId, agentId: agent.id, sessionId });
      return;
    }

    // Codex 式：回合结束后（完成/轮次上限）按 FIFO 出队下一条
    void this.startNextQueued({ tenantId, agentId: agent.id, sessionId });

    // —— 运行后处理（不阻塞会话）：自动标题 + 自动记忆 ——
    void (async () => {
      const resolved =
        autoMemoryOn ? ((await resolvedMemoryPromise) ?? resolvedMemory) : null;
      await this.postRun({
        tenantId,
        agent,
        sessionId,
        runId,
        cloud,
        isFirstTurn: input.isFirstTurn,
        userContent: lastUserContent,
        assistantContent: result.finalText,
        resolvedMemory: resolved,
      });
    })().catch((err) => {
      recordPlatformFault("cloud_agent.post_run", err, { subsystem: "cloud_agent" });
    });
  }

  private makeHookLoopFns(
    agent: Agent,
    hookOpts: {
      extraPackages?: LoadedProjectContext["hookPackages"];
      workingDir?: string;
      sessionId?: string;
    },
  ): Pick<AgentLoopHooks, "interceptCall" | "afterToolCall" | "beforeStop"> {
    const hooksSvc = this.deps.agentHooks;
    if (!hooksSvc) return {};
    const preInject = new Map<string, string>();
    return {
      interceptCall: async (call, args) => {
        const pre = await hooksSvc.runEvent(agent, "PreToolUse", {
          toolName: call.function.name,
          toolArgs: args,
          ...hookOpts,
        });
        const commit = isGitCommitCommand(call.function.name, args)
          ? await hooksSvc.runEvent(agent, "PreCommit", {
              toolName: call.function.name,
              toolArgs: args,
              ...hookOpts,
            })
          : [];
        const combined = [...pre, ...commit];
        const inject = collectInjectText(combined);
        if (inject) preInject.set(call.id, inject);
        const denied = firstDeny(combined);
        if (!denied) return undefined;
        return {
          result: {
            content: [
              {
                type: "text",
                text: denied.reason ?? "hook denied this tool call",
              },
            ],
            isError: true,
          },
        };
      },
      afterToolCall: async (call, args, outcome) => {
        const post = await hooksSvc.runEvent(
          agent,
          outcome.isError ? "PostToolUseFailure" : "PostToolUse",
          {
            toolName: call.function.name,
            toolArgs: args,
            toolResultText: outcome.resultText,
            isError: outcome.isError,
            ...hookOpts,
          },
        );
        const parts = [preInject.get(call.id), collectInjectText(post)].filter(
          (s): s is string => !!s?.trim(),
        );
        preInject.delete(call.id);
        return parts.join("\n\n") || undefined;
      },
      beforeStop: async (lastText) => {
        const results = await hooksSvc.runEvent(agent, "Stop", {
          lastAssistantMessage: lastText,
          ...hookOpts,
        });
        const inject = collectInjectText(results);
        const denied = firstDeny(results);
        return {
          block: Boolean(denied),
          injectText: [inject, denied?.reason].filter(Boolean).join("\n\n") || undefined,
        };
      },
    };
  }

  private wrapCompactHook(
    agent: Agent,
    inner: NonNullable<AgentLoopHooks["compactInLoop"]> | undefined,
    hookOpts: {
      extraPackages?: LoadedProjectContext["hookPackages"];
      workingDir?: string;
      sessionId?: string;
    },
  ): AgentLoopHooks["compactInLoop"] | undefined {
    if (!inner) return undefined;
    return async (msgs, reason) => {
      if (this.deps.agentHooks) {
        const pre = await this.deps.agentHooks.runEvent(agent, "PreCompact", {
          ...hookOpts,
          userPrompt: reason,
          matcherValue: "auto",
        });
        if (firstDeny(pre)) return false;
      }
      return inner(msgs, reason);
    };
  }

  private async loadProjectContext(
    agent: Agent,
    slug: string,
  ): Promise<LoadedProjectContext> {
    const empty: LoadedProjectContext = { skillsSummary: "", skills: [], hookPackages: [] };
    const provider = this.deps.workspaceFsProvider;
    if (!provider) return empty;
    try {
      const fs = await provider.forAgentBinding({
        id: agent.id,
        tenantId: agent.tenantId,
        runtimeNodeId: agent.runtimeNodeId,
      });
      return await loadProjectContext(fs, slug);
    } catch {
      return empty;
    }
  }

  /**
   * 将消息里 `workspace:` 占位的图片部件解析为 data URI。
   * 与 AI SDK / AI Gateway 的多模态形态保持一致：图片作为独立
   * content part 传给支持 image input 的模型；不在这里做小尺寸截断。
   * 不支持图片的路由会在协议适配器里丢弃 image part。
   */
  private async resolveWorkspaceImages(
    agent: Agent,
    messages: ModelChatMessage[],
  ): Promise<void> {
    const provider = this.deps.workspaceFsProvider;
    let need = false;
    for (const m of messages) {
      if (
        m.parts?.some(
          (p) =>
            p.type === "image_url" && p.imageUrl.url.startsWith(WORKSPACE_IMAGE_PREFIX),
        )
      ) {
        need = true;
        break;
      }
    }
    if (!need) return;

    let fs: WorkspaceFs | undefined;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (!m.parts?.length) continue;
      const resolved: ModelChatContentPart[] = [];
      for (const part of m.parts) {
        if (
          part.type !== "image_url" ||
          !part.imageUrl.url.startsWith(WORKSPACE_IMAGE_PREFIX)
        ) {
          resolved.push(part);
          continue;
        }
        if (!provider) continue;
        const path = part.imageUrl.url.slice(WORKSPACE_IMAGE_PREFIX.length);
        try {
          if (fs === undefined) {
            fs = await provider.forAgentBinding({
              id: agent.id,
              tenantId: agent.tenantId,
              runtimeNodeId: agent.runtimeNodeId,
            });
          }
          const file = await fs.readBytes(path);
          if (file.data.length === 0) continue;
          resolved.push({
            type: "image_url",
            imageUrl: {
              url: `data:${guessImageMime(path)};base64,${file.data.toString("base64")}`,
            },
          });
        } catch {
          // 文件被移动/删除等：仅保留文本注记
        }
      }
      if (resolved.some((p) => p.type === "image_url")) {
        m.parts = resolved;
      } else {
        // 没有可用图片时退回纯文本 content，避免触发不支持多模态的上游报错
        delete m.parts;
      }
    }
  }

  /**
   * spawn_subagent 调用的批量并行处理（主循环与子代理循环共用）：
   * 同一轮内的多个派生并行执行（上限 4），结果按 toolCallId 回填并携带
   * 子会话链接；取消信号沿父链传导（每级组合上一级的取消检查）。
   */
  private spawnSubagentsHook(input: {
    tenantId: string;
    agent: Agent;
    nameMap: Map<string, string>;
    /** 派生出的子代理的嵌套深度（主循环派生 = 1） */
    childDepth: number;
    parentSessionId: string;
    parentRunId: string;
    isCancelled: () => Promise<boolean>;
    project?: string | null;
  }): NonNullable<AgentLoopHooks["preResolveCalls"]> {
    const { tenantId, agent, nameMap } = input;
    return async (calls) => {
      const outcomes = new Map<string, LoopToolOutcome>();
      const subCalls = calls.filter(
        (c) =>
          (nameMap.get(c.function.name) ?? c.function.name) === SUBAGENT_TOOL_QUALIFIED,
      );
      if (subCalls.length === 0) return outcomes;
      await mapConcurrent(subCalls, 4, async (call) => {
        try {
          const sub = await this.runSubagent(
            tenantId,
            agent,
            parseToolArgs(call.function.arguments),
            {
              depth: input.childDepth,
              isCancelled: input.isCancelled,
              onProgress: (message, data) =>
                void this.log(input.parentSessionId, input.parentRunId, "info", message, data),
              origin: {
                source: "agent_loop",
                parentSessionId: input.parentSessionId,
                parentRunId: input.parentRunId,
                parentToolCallId: call.id,
                depth: input.childDepth,
              },
              project: input.project,
            },
          );
          outcomes.set(call.id, {
            result: { content: [{ type: "text", text: sub.text }] },
            link: { sessionId: sub.sessionId, agentId: agent.id },
          });
        } catch (err) {
          outcomes.set(call.id, {
            result: {
              content: [
                { type: "text", text: err instanceof Error ? err.message : String(err) },
              ],
              isError: true,
            },
          });
        }
      });
      return outcomes;
    };
  }

  /**
   * 云端子代理：与主 Agent 共享工作区和工具面，但上下文完全隔离。
   * 未达嵌套深度上限（cloud.maxSubagentDepth，默认 2）时可继续派生
   * 下一级子代理分层拆解任务；达到上限后派生工具从工具面剔除，防止递归爆炸。
   * 运行全程落库为 kind=subagent 的会话（可实时观看/回放），
   * origin 记录父会话、触发它的工具调用与嵌套深度；外部 MCP 客户端
   * （/mcp/agents/:slug 调 re_spawn_subagent）与 agent loop 共用此实现。
   */
  async runSubagent(
    tenantId: string,
    agent: Agent,
    args: Record<string, unknown>,
    opts: {
      isCancelled?: () => Promise<boolean>;
      onProgress?: (message: string, data?: Record<string, unknown>) => void;
      /** 来源链接；缺省视为外部 MCP 客户端触发 */
      origin?: CloudAgentSessionOrigin;
      /** 本子代理的嵌套深度；主循环 / 外部 MCP 派生 = 1（缺省） */
      depth?: number;
      project?: string | null;
    },
  ): Promise<{ text: string; sessionId: string }> {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) throw new Error("task 必填：请提供自包含的子任务描述");
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const expected =
      typeof args.expected_output === "string" ? args.expected_output.trim() : "";

    const cloud = agentCloudConfig(agent);
    const depth = Math.max(1, Math.floor(opts.depth ?? 1));
    const maxDepth = cloud.maxSubagentDepth ?? SUBAGENT_MAX_DEPTH_DEFAULT;
    /** 未达深度上限：保留派生工具，允许继续分层拆解 */
    const canSpawn = depth < maxDepth;
    const allTools = await this.deps.gateway.listToolsForAgent(agent);
    const { definitions, nameMap } = toolsToDefinitions(
      canSpawn
        ? allTools
        : allTools.filter((t) => t.qualifiedName !== SUBAGENT_TOOL_QUALIFIED),
    );

    const session = await this.store.createSession({
      tenantId,
      agentId: agent.id,
      title: `子任务：${task.slice(0, 40)}${task.length > 40 ? "…" : ""}`,
      kind: "subagent",
      project: opts.project ?? null,
      origin: { source: "mcp", callerAgentId: agent.id, depth, ...opts.origin },
    });
    const run = await this.store.createRun(session.id);
    await this.store.markRunStarted(run.id);

    const shortId = session.id.slice(0, 6);
    const userContent = `# 委派任务\n${task}${context ? `\n\n# 背景信息\n${context}` : ""}`;
    const messageId = newId();
    await this.store.appendEvent({
      sessionId: session.id,
      type: "user_message",
      runId: run.id,
      payload: { messageId, content: userContent, parentRunId: null },
    });
    await this.store.appendEvent({
      sessionId: session.id,
      type: "run_start",
      runId: run.id,
      payload: { runId: run.id, replyToMessageId: messageId },
    });
    opts.onProgress?.(`子代理[${shortId}] 启动`, {
      task: task.slice(0, 200),
      childSessionId: session.id,
      depth,
    });

    const subagentSkills = this.deps.skills
      ? await this.deps.skills.promptSummary(tenantId, agent.id)
      : "";
    const projectCtx = opts.project
      ? await this.loadProjectContext(agent, opts.project)
      : { skillsSummary: "", skills: [], hookPackages: [] as LoadedProjectContext["hookPackages"] };
    const mergedSkills = [subagentSkills, projectCtx.skillsSummary].filter(Boolean).join("\n");
    const messages: ModelChatMessage[] = [
      {
        role: "system",
        content: buildSubagentPrompt(agent, cloud, {
          expectedOutput: expected || undefined,
          subagents: canSpawn,
          skills: mergedSkills || undefined,
          project: opts.project ?? null,
          projectInstructions: projectCtx.instructions,
        }),
      },
      { role: "user", content: userContent },
    ];

    /** 本级 + 祖先链的取消检查（传给下一级子代理，逐级组合） */
    const isCancelledChain = async (): Promise<boolean> =>
      (await this.store.isCancelRequested(run.id)) ||
      (opts.isCancelled ? await opts.isCancelled() : false);

    try {
      const autoCompactOn = cloud.autoCompact !== false;
      const budget = await this.resolveCompactBudgetForCloud(tenantId, cloud);
      const compactHook = autoCompactOn
        ? this.makeCompactInLoopHook({
            tenantId,
            agent,
            sessionId: session.id,
            runId: run.id,
            cloud,
            budget,
            parentTitle: session.title,
          })
        : undefined;
      const projectHookRunOpts = {
        extraPackages: projectCtx.hookPackages,
        sessionId: session.id,
        ...(opts.project ? { workingDir: projectDefaultWorkingDir(opts.project) } : {}),
      };
      const hookFns = this.makeHookLoopFns(agent, projectHookRunOpts);
      const result = await runAgentLoop(this.loopDeps, {
        tenantId,
        agent,
        cloud,
        sessionId: session.id,
        runId: run.id,
        messages,
        definitions,
        nameMap,
        compactBudget: budget,
        maxRounds: 16,
        maxRoundsNote: (max, lastText) =>
          `子代理达到轮次上限（${max}），任务可能未完成。${
            lastText ? `最后进展：${lastText.slice(0, 2000)}` : "建议缩小任务范围后重新派生。"
          }`,
        ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
        ...(opts.project ? { defaultWorkingDir: projectDefaultWorkingDir(opts.project) } : {}),
        ...(opts.project ? { projectSlug: opts.project } : {}),
        hooks: {
          ...(compactHook
            ? { compactInLoop: this.wrapCompactHook(agent, compactHook, projectHookRunOpts) }
            : {}),
          ...hookFns,
          ...(canSpawn
            ? {
                preResolveCalls: this.spawnSubagentsHook({
                  tenantId,
                  agent,
                  nameMap,
                  childDepth: depth + 1,
                  parentSessionId: session.id,
                  parentRunId: run.id,
                  isCancelled: isCancelledChain,
                  project: opts.project ?? null,
                }),
              }
            : {}),
        },
      });

      if (result.status === "cancelled") {
        opts.onProgress?.(`子代理[${shortId}] 已取消`, { childSessionId: session.id });
        throw new ModelCallAbortedError("子代理已取消（父任务取消或会话被终止）");
      }
      opts.onProgress?.(`子代理[${shortId}] 完成（${result.rounds} 轮）`, {
        childSessionId: session.id,
      });
      const answer = result.finalText.trim();
      return {
        text: answer ? answer.slice(0, RESULT_TEXT_LIMIT) : "（子代理无输出）",
        sessionId: session.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 取消已由引擎收尾；其余异常补记失败事件后向父级抛出
      if (!isAbortError(err) && !(await isCancelledChain())) {
        opts.onProgress?.(`子代理[${shortId}] 失败`, {
          childSessionId: session.id,
          error: message.slice(0, 300),
        });
        try {
          await failRun(this.store, session.id, run.id, message);
        } catch (e) {
          recordPlatformFault("cloud_agent.subagent_error", e, {
            subsystem: "cloud_agent",
          });
        }
      }
      throw err;
    }
  }

  /**
   * 跨 Agent 委派：目标 Agent 以自己的身份、工具与提示词执行任务，
   * 运行全程落库为目标 Agent 名下 kind=delegate 的会话（origin 记录调用方）。
   */
  private async delegateToAgent(
    tenantId: string,
    caller: Agent,
    peers: Agent[],
    args: Record<string, unknown>,
    opts: {
      isCancelled: () => Promise<boolean>;
      origin?: CloudAgentSessionOrigin;
    },
  ): Promise<{ text: string; sessionId: string; agentId: string }> {
    const slug = typeof args.agentSlug === "string" ? args.agentSlug.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    if (!slug || !task) throw new Error("agentSlug 与 task 必填");
    if (slug === caller.slug) throw new Error("不能委派给自己");
    const target = peers.find((a) => a.slug === slug || a.id === slug);
    if (!target) throw new Error(`未找到 Agent: ${slug}`);

    const targetCloud = agentCloudConfig(target);
    const tools = await this.deps.gateway.listToolsForAgent(target);
    const { definitions, nameMap } = toolsToDefinitions(tools);

    const session = await this.store.createSession({
      tenantId,
      agentId: target.id,
      title: `委派：${task.slice(0, 40)}${task.length > 40 ? "…" : ""}`,
      kind: "delegate",
      origin: {
        source: "agent_loop",
        callerAgentId: caller.id,
        callerAgentName: caller.name,
        ...opts.origin,
      },
    });
    const run = await this.store.createRun(session.id);
    await this.store.markRunStarted(run.id);

    const userContent = `来自 Agent「${caller.name}」的委派任务：\n${task}${
      context ? `\n\n补充上下文：\n${context}` : ""
    }`;
    const messageId = newId();
    await this.store.appendEvent({
      sessionId: session.id,
      type: "user_message",
      runId: run.id,
      payload: { messageId, content: userContent, parentRunId: null },
    });
    await this.store.appendEvent({
      sessionId: session.id,
      type: "run_start",
      runId: run.id,
      payload: { runId: run.id, replyToMessageId: messageId },
    });

    const messages: ModelChatMessage[] = [
      { role: "system", content: buildSystemPrompt(target, targetCloud) },
      { role: "user", content: userContent },
    ];

    try {
      const autoCompactOn = targetCloud.autoCompact !== false;
      const budget = await this.resolveCompactBudgetForCloud(tenantId, targetCloud);
      const compactHook = autoCompactOn
        ? this.makeCompactInLoopHook({
            tenantId,
            agent: target,
            sessionId: session.id,
            runId: run.id,
            cloud: targetCloud,
            budget,
            parentTitle: session.title,
          })
        : undefined;
      const hookFns = this.makeHookLoopFns(target, { sessionId: session.id });
      const result = await runAgentLoop(this.loopDeps, {
        tenantId,
        agent: target,
        cloud: targetCloud,
        sessionId: session.id,
        runId: run.id,
        messages,
        definitions,
        nameMap,
        compactBudget: budget,
        maxRounds: 12,
        maxRoundsNote: (max) => `达到委派轮次上限（${max}），任务可能未完成。`,
        isCancelled: opts.isCancelled,
        // 目标 Agent 在委派中派生子代理：同样并行执行、记录链接、传导取消
        hooks: {
          ...(compactHook
            ? {
                compactInLoop: this.wrapCompactHook(target, compactHook, {
                  sessionId: session.id,
                }),
              }
            : {}),
          ...hookFns,
          preResolveCalls: this.spawnSubagentsHook({
            tenantId,
            agent: target,
            nameMap,
            childDepth: 1,
            parentSessionId: session.id,
            parentRunId: run.id,
            isCancelled: async () =>
              (await this.store.isCancelRequested(run.id)) || (await opts.isCancelled()),
          }),
        },
      });

      if (result.status === "cancelled") {
        throw new ModelCallAbortedError("委派已取消（父 Run 取消或会话被终止）");
      }
      const answer = result.finalText.trim();
      return {
        text: (answer ? `[${target.name}] ${answer}` : `[${target.name}] （无回复内容）`).slice(
          0,
          8_000,
        ),
        sessionId: session.id,
        agentId: target.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isAbortError(err) && !(await opts.isCancelled())) {
        try {
          await failRun(this.store, session.id, run.id, message);
        } catch (e) {
          recordPlatformFault("cloud_agent.delegate_error", e, {
            subsystem: "cloud_agent",
          });
        }
      }
      throw err;
    }
  }

  private async postRun(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    isFirstTurn: boolean;
    userContent: string;
    assistantContent: string;
    resolvedMemory: ResolvedMemory | null;
  }): Promise<void> {
    const { tenantId, agent, sessionId, runId, cloud } = input;

    // 软阈值预压缩：本轮已答完，同步摘要不挡用户阅读，降低下一轮硬压概率
    if (cloud.autoCompact !== false) {
      try {
        await this.maybeSoftCompactAfterRun({
          tenantId,
          agent,
          sessionId,
          runId,
          cloud,
        });
      } catch (err) {
        await this.log(sessionId, runId, "warn", "Run 后软压缩失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 自动标题：首轮完成后用模型生成
    if (input.isFirstTurn && cloud.autoTitle !== false && input.userContent) {
      try {
        const res = await this.deps.modelRouter.chat(
          tenantId,
          [
            {
              role: "system",
              content:
                "为这段对话生成一个简短标题：中文优先、不超过 16 个字、不含引号和句号，直接输出标题本身。",
            },
            {
              role: "user",
              content: `用户：${input.userContent.slice(0, 800)}\n\n助手：${input.assistantContent.slice(0, 800)}`,
            },
          ],
          {
            capability: "chat",
            ...(cloud.modelRouteId
              ? { routeId: cloud.modelRouteId }
              : cloud.model
                ? { alias: cloud.model }
                : {}),
          },
        );
        const title = (res.content ?? "")
          .trim()
          .replace(/^["'「『]+|["'」』。]+$/g, "")
          .split("\n")[0]
          ?.slice(0, 24);
        if (title) {
          await this.store.updateSession(tenantId, agent.id, sessionId, { title });
          await this.store.appendEvent({
            sessionId,
            type: "session_update",
            runId,
            payload: { title },
          });
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "自动标题生成失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 自动记忆提取（类 ChatGPT：对话后判断是否有值得长期记住的信息）
    if (input.resolvedMemory && input.userContent) {
      try {
        const saved = await extractAndSaveMemories(
          {
            modelRouter: this.deps.modelRouter,
            memoryStore: this.deps.memoryStore ?? null,
          },
          {
            tenantId,
            agent,
            cloud,
            resolved: input.resolvedMemory,
            userContent: input.userContent,
            assistantContent: input.assistantContent,
          },
        );
        if (saved.length > 0) {
          await this.store.appendEvent({
            sessionId,
            type: "memory_updated",
            runId,
            payload: {
              runId,
              items: saved.map((s) => ({ id: s.id, content: s.content, layer: s.layer })),
            },
          });
          await this.log(sessionId, runId, "info", `自动记忆写入 ${saved.length} 条`);
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "自动记忆提取失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Run 结束后：若压缩点之后的历史仍超软阈值，同步预压缩（下一轮直接吃到摘要）。
   */
  private async maybeSoftCompactAfterRun(input: {
    tenantId: string;
    agent: Agent;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
  }): Promise<void> {
    const budget = await this.resolveCompactBudgetForCloud(
      input.tenantId,
      input.cloud,
    );
    const lastCompaction = await this.store.getLastCompaction(input.sessionId);
    const lastSeq = lastCompaction?.seq ?? 0;
    const lastPayload = (lastCompaction?.payload ?? {}) as Record<string, unknown>;
    const previousSummary =
      typeof lastPayload.summary === "string" ? lastPayload.summary : "";
    const previousOps = fileOpsFromCompactionPayload(lastPayload);

    const history = await this.store.listEventsForChain(input.sessionId, {
      afterSeq: lastSeq,
    });
    const lastUser = [...history].reverse().find((e) => e.type === "user_message");
    const mid = lastUser
      ? (lastUser.payload as Record<string, unknown>).messageId
      : null;
    if (typeof mid !== "string") return;

    const chainRes = buildChainMessages(
      history.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      mid,
    );
    prepareHistoryForModel(chainRes.messages, budget);
    // 已超硬阈值本应在 Run 前压过；此处只处理 soft 带
    if (!isOverSoftBudget(chainRes.messages, budget)) return;
    // 刚写过 compact 且新增很少则跳过
    if (lastSeq > 0 && history.length < 4) return;

    const split = splitMessagesForCompaction(chainRes.messages, budget);
    if (split.older.length === 0) return;

    await this.compactHistoryRealtime({
      tenantId: input.tenantId,
      agent: input.agent,
      sessionId: input.sessionId,
      runId: input.runId,
      cloud: input.cloud,
      messages: chainRes.messages,
      budget,
      previousSummary,
      previousOps,
      parentTitle: undefined,
      source: "soft",
      announce: false,
    });
  }
}
