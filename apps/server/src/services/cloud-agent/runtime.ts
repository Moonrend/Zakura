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
import {
  parseCloudAgentConfig,
  type CloudAgentAttachment,
  type CloudAgentConfig,
  type CloudAgentContextSourceItem,
  type CloudAgentRunOptions,
  type CloudAgentSessionOrigin,
  type ModelChatContentPart,
  type ModelChatMessage,
  type ModelToolDefinition,
} from "@zakura/shared";
import type { WorkspaceFsProvider, WorkspaceFs } from "@zakura/core";
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
import {
  approxMessagesChars,
  buildCompactionDigest,
  buildChainMessages,
  parseAttachments,
  COMPACT_KEEP_RECENT,
  COMPACT_THRESHOLD_CHARS,
  WORKSPACE_IMAGE_PREFIX,
  guessImageMime,
} from "./messages.js";
import {
  DELEGATE_TOOL_NAME,
  RESULT_TEXT_LIMIT,
  parseToolArgs,
  toolsToDefinitions,
} from "./tools.js";
import { buildSubagentPrompt, buildSystemPrompt } from "./prompts.js";
import { extractAndSaveMemories } from "./memory.js";
import {
  appendRunLog,
  failRun,
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopHooks,
  type LoopToolOutcome,
} from "./loop.js";

export type SessionCompactionResult = {
  summary: string;
  beforeChars: number;
  afterChars: number;
  droppedMessages: number;
  keptMessages: number;
  systemSessionId?: string;
};

/** Agent.configJson → cloud 配置（宽容解析） */
export function agentCloudConfig(agent: Agent): CloudAgentConfig {
  try {
    return parseCloudAgentConfig(JSON.parse(agent.configJson || "{}"));
  } catch {
    return {};
  }
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
};

export class CloudAgentRuntime {
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
    /** 随消息上传的附件（已在 Agent 工作区） */
    attachments?: CloudAgentAttachment[];
    /** 本次用户触发 Run 的调用时模型选项。 */
    options?: CloudAgentRunOptions;
  }): Promise<{ runId: string }> {
    const content = input.content?.trim() ?? "";
    const attachments = parseAttachments(input.attachments);
    const isRegenerate = Boolean(input.regenerateOfMessageId || input.retry);
    if (!isRegenerate && !content && attachments.length === 0) {
      throw new Error("消息不能为空");
    }

    const session = await this.store.getSession(
      input.tenantId,
      input.agentId,
      input.sessionId,
    );
    if (!session) throw new Error("会话不存在");
    if (session.activeRunId) throw new Error("当前会话已有进行中的 Run，请先等待或取消");

    const agent = await this.deps.agentService.get(input.tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");

    let targetMessageId: string;
    if (isRegenerate) {
      if (session.lastSeq === 0) throw new Error("会话为空，无法重新生成");
      const events = await this.store.listEvents(input.sessionId, { limit: 2000 });
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

    if (!isRegenerate) {
      // 先用首条消息截断作临时标题，运行结束后再由模型润色
      if (isFirstTurn && session.title === "新对话") {
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
          ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
          ...(attachments.length ? { attachments } : {}),
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
    void this.executeRun({
      tenantId: input.tenantId,
      agent,
      sessionId: input.sessionId,
      runId: run.id,
      targetMessageId,
      isFirstTurn,
      ...(input.options ? { options: input.options } : {}),
    }).catch(async (err) => {
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
          return;
        }
        console.error("[cloud-agent] run failed:", message);
        await failRun(this.store, input.sessionId, run.id, message);
      } catch (e) {
        console.error("[cloud-agent] failed to record run error:", e);
      }
    });

    return { runId: run.id };
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
  }): ModelChatMessage[] {
    const digest = buildCompactionDigest(input.messages);
    const previous = input.previousSummary?.trim();
    const prompt = previous
      ? `已有摘要：\n${previous}\n\n把已有摘要与以下新增对话合并为一份中文上下文摘要。保留：用户目标、关键事实与数据、已完成/未完成事项、重要决定、仍需沿用的约束。800 字以内，直接输出摘要正文。`
      : "把以下对话记录压缩成中文上下文摘要。保留：用户目标、关键事实与数据、已完成/未完成事项、重要决定、仍需沿用的约束。800 字以内，直接输出摘要正文。";
    return [
      { role: "system", content: prompt },
      { role: "user", content: digest },
    ];
  }

  private async summarizeMessages(input: {
    tenantId: string;
    cloud: CloudAgentConfig;
    messages: ModelChatMessage[];
    previousSummary?: string;
    audit?: {
      agent: Agent;
      parentSessionId: string;
      parentTitle: string;
    };
  }): Promise<{ summary: string; systemSessionId?: string }> {
    const messages = this.compactionCallMessages(input);
    const route = {
      capability: "chat" as const,
      ...(input.cloud.model ? { alias: input.cloud.model } : {}),
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
      return { summary, systemSessionId: audit?.sessionId };
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

    const history = await this.store.listEvents(input.sessionId, { limit: 2000 });
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

    const lastCompaction = [...history]
      .reverse()
      .find((e) => e.type === "context_compacted");
    const lastCompactionSeq = lastCompaction?.seq ?? 0;
    const previousSummary =
      typeof (lastCompaction?.payload as Record<string, unknown> | undefined)?.summary ===
      "string"
        ? String((lastCompaction!.payload as Record<string, unknown>).summary)
        : "";

    const targetUserEvent = history.find(
      (e) =>
        e.type === "user_message" &&
        (e.payload as Record<string, unknown>).messageId === targetMessageId,
    );
    const canUsePreviousSummary =
      Boolean(previousSummary) && Boolean(targetUserEvent && targetUserEvent.seq > lastCompactionSeq);
    const chainEvents = canUsePreviousSummary
      ? history.filter((e) => e.seq > lastCompactionSeq)
      : history;

    const chainRes = buildChainMessages(
      chainEvents.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      targetId,
    );
    const allMessages = chainRes.messages;
    const beforeChars = approxMessagesChars(allMessages);
    const newerEvents = history.filter((e) => e.seq > lastCompactionSeq);
    const newerUserMessages = newerEvents.filter((e) => e.type === "user_message").length;
    const newerAssistantMessages = newerEvents.filter(
      (e) => e.type === "assistant_message",
    ).length;
    if (allMessages.length <= COMPACT_KEEP_RECENT && !previousSummary) {
      throw new Error("当前会话还不需要压缩");
    }
    if (lastCompactionSeq > 0 && newerUserMessages + newerAssistantMessages < 2) {
      throw new Error("上次压缩后新增内容太少");
    }

    const keep = allMessages.slice(-COMPACT_KEEP_RECENT);
    const older = allMessages.slice(0, allMessages.length - keep.length);
    if (older.length === 0 && !previousSummary) {
      throw new Error("没有足够的旧消息可压缩");
    }

    const summarized = await this.summarizeMessages({
      tenantId: input.tenantId,
      cloud,
      messages: older.length ? older : allMessages,
      previousSummary: canUsePreviousSummary ? previousSummary : undefined,
      audit: {
        agent,
        parentSessionId: input.sessionId,
        parentTitle: session.title,
      },
    });
    const summary = summarized.summary;
    if (!summary) throw new Error("摘要为空，请稍后重试");

    const keptChars = approxMessagesChars(keep);
    const afterChars = keptChars + summary.length + 80;
    const result: SessionCompactionResult = {
      summary,
      beforeChars,
      afterChars,
      droppedMessages: older.length,
      keptMessages: keep.length,
      systemSessionId: summarized.systemSessionId,
    };
    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "context_compacted",
      runId: null,
      payload: { ...result, source: "manual" },
    });
    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "context_sources",
      runId: null,
      payload: {
        runId: "",
        items: [{ kind: "summary", title: "对话压缩摘要", content: summary }],
      },
    });
    return result;
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

    const cloud = agentCloudConfig(agent);
    const enableTools = cloud.enableTools !== false;

    await this.store.appendEvent({
      sessionId,
      type: "run_status",
      runId,
      payload: { runId, status: "thinking" },
    });

    const history = await this.store.listEvents(sessionId, { limit: 2000 });
    const lastCompaction = [...history]
      .reverse()
      .find((e) => e.type === "context_compacted");
    const lastCompactionSeq = lastCompaction?.seq ?? 0;
    const compactedSummary =
      typeof (lastCompaction?.payload as Record<string, unknown> | undefined)?.summary ===
      "string"
        ? String((lastCompaction!.payload as Record<string, unknown>).summary)
        : "";
    const targetUserEvent = history.find(
      (e) =>
        e.type === "user_message" &&
        (e.payload as Record<string, unknown>).messageId === input.targetMessageId,
    );
    const canUseCompactedSummary =
      Boolean(compactedSummary) && Boolean(targetUserEvent && targetUserEvent.seq > lastCompactionSeq);
    const chainEvents = canUseCompactedSummary
      ? history.filter((e) => e.seq > lastCompactionSeq)
      : history;
    // 沿分支链重建上下文：重新生成的旧变体与其他分支不进入模型输入
    const chainRes = buildChainMessages(
      chainEvents.map((e) => ({
        type: e.type,
        runId: e.runId,
        payload: e.payload as unknown as Record<string, unknown>,
      })),
      input.targetMessageId,
    );
    let historyMsgs = chainRes.messages;
    const lastUserContent = chainRes.userContent;

    // —— 自动记忆召回 ——
    const autoMemoryOn =
      agent.enableMemory &&
      cloud.autoMemory !== false &&
      Boolean(this.deps.memoryProviders);
    let resolvedMemory: ResolvedMemory | null = null;
    let memoryContext = "";
    const sourceItems: CloudAgentContextSourceItem[] = [];
    if (autoMemoryOn) {
      try {
        resolvedMemory = await resolveAgentMemory(this.deps.memoryProviders!, agent);
        if (resolvedMemory) {
          const ctx = await buildMemoryContext(
            this.deps.memoryStore ?? null,
            resolvedMemory,
            agent,
            lastUserContent || undefined,
          );
          memoryContext = ctx.text;
          if (ctx.count > 0) {
            await this.log(sessionId, runId, "info", `记忆召回 ${ctx.count} 条`, {
              retrievalMode: ctx.retrievalMode,
            });
            for (const m of ctx.items) {
              sourceItems.push({
                kind: "memory",
                title: m.layer ? `记忆 · ${m.layer}` : "记忆",
                content: m.content,
                ...(m.id ? { id: m.id } : {}),
                ...(m.layer ? { layer: m.layer } : {}),
              });
            }
          }
        }
      } catch (err) {
        await this.log(sessionId, runId, "warn", "记忆召回失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // —— 历史压缩：超长时把旧消息摘要进系统提示 ——
    let historySummary = canUseCompactedSummary ? compactedSummary : "";
    if (historySummary) {
      sourceItems.push({
        kind: "summary",
        title: "对话压缩摘要",
        content: historySummary,
      });
    }
    if (approxMessagesChars(historyMsgs) > COMPACT_THRESHOLD_CHARS) {
      const keep = historyMsgs.slice(-COMPACT_KEEP_RECENT);
      const older = historyMsgs.slice(0, historyMsgs.length - keep.length);
      try {
        const currentSession = await this.store.getSession(tenantId, agent.id, sessionId);
        const summarized = await this.summarizeMessages({
          tenantId,
          cloud,
          messages: older,
          previousSummary: historySummary,
          ...(currentSession
            ? {
                audit: {
                  agent,
                  parentSessionId: sessionId,
                  parentTitle: currentSession.title,
                },
              }
            : {}),
        });
        const beforeChars = approxMessagesChars(historyMsgs);
        historySummary = summarized.summary;
        historyMsgs = keep;
        const afterChars = approxMessagesChars(historyMsgs) + historySummary.length + 80;
        await this.log(sessionId, runId, "info", "历史过长，已压缩为摘要", {
          droppedMessages: older.length,
          summaryChars: historySummary.length,
        });
        if (historySummary) {
          sourceItems.push({
            kind: "summary",
            title: "对话摘要",
            content: historySummary,
          });
          await this.store.appendEvent({
            sessionId,
            type: "context_compacted",
            runId,
            payload: {
              summary: historySummary,
              source: "auto",
              beforeChars,
              afterChars,
              droppedMessages: older.length,
              keptMessages: keep.length,
              systemSessionId: summarized.systemSessionId,
            },
          });
        }
      } catch (err) {
        // 摘要失败：硬截断，保底继续
        historyMsgs = historyMsgs.slice(-COMPACT_KEEP_RECENT * 2);
        await this.log(sessionId, runId, "warn", "历史摘要失败，改为截断", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (sourceItems.length > 0) {
      try {
        await this.store.appendEvent({
          sessionId,
          type: "context_sources",
          runId,
          payload: { runId, items: sourceItems },
        });
      } catch (err) {
        console.warn("[cloud-agent] context_sources publish failed:", err);
      }
    }

    // —— 工具面：MCP + 原生 + 跨 Agent 委派 ——
    let definitions: ModelToolDefinition[] = [];
    let nameMap = new Map<string, string>();
    let peerAgents: Agent[] = [];
    let peerAgentsDesc = "";
    if (enableTools) {
      const tools = await this.deps.gateway.listToolsForAgent(agent);
      const mapped = toolsToDefinitions(tools);
      definitions = mapped.definitions;
      nameMap = mapped.nameMap;

      try {
        peerAgents = (await this.deps.agentService.list(tenantId)).filter(
          (a) => a.id !== agent.id,
        );
      } catch {
        peerAgents = [];
      }
      if (peerAgents.length > 0) {
        peerAgentsDesc = peerAgents
          .slice(0, 20)
          .map((a) => `- ${a.slug}（${a.name}）`)
          .join("\n");
        definitions.push({
          type: "function",
          function: {
            name: DELEGATE_TOOL_NAME,
            description:
              "将一个独立子任务委派给同租户的另一个 Agent 执行（它拥有自己的工具与记忆），阻塞等待其最终答复。适用于需要该 Agent 专属能力或职责分工的场景。",
            parameters: {
              type: "object",
              properties: {
                agentSlug: {
                  type: "string",
                  description: `目标 Agent 的 slug。可选：${peerAgents
                    .slice(0, 20)
                    .map((a) => a.slug)
                    .join(", ")}`,
                },
                task: { type: "string", description: "交给对方的任务描述，应自包含" },
                context: {
                  type: "string",
                  description: "可选补充上下文（对方看不到本会话历史）",
                },
              },
              required: ["agentSlug", "task"],
            },
          },
        });
      }
    }

    const hasSubagent = definitions.some(
      (d) => d.function.name === SUBAGENT_TOOL_QUALIFIED,
    );
    const skillsSummary = this.deps.skills
      ? await this.deps.skills.promptSummary(tenantId, agent.id)
      : "";
    const systemPrompt = buildSystemPrompt(agent, cloud, {
      memoryContext: memoryContext || undefined,
      historySummary: historySummary || undefined,
      peerAgents: peerAgentsDesc || undefined,
      subagents: hasSubagent,
      skills: skillsSummary || undefined,
    });
    const messages: ModelChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyMsgs,
    ];

    // 图片附件：读工作区文件转 data URI（多模态输入）
    await this.resolveWorkspaceImages(agent, messages);

    await this.log(sessionId, runId, "info", "Run 开始", {
      model: cloud.model ?? "(默认路由)",
      tools: definitions.length,
      historyMessages: historyMsgs.length,
      memoryInjected: Boolean(memoryContext),
    });

    const result = await runAgentLoop(this.loopDeps, {
      tenantId,
      agent,
      cloud,
      sessionId,
      runId,
      messages,
      definitions,
      nameMap,
      ...(input.options ? { options: input.options } : {}),
      ...(cloud.maxToolRounds != null ? { maxRounds: cloud.maxToolRounds } : {}),
      hooks: {
        toolTitle: (modelName) =>
          modelName === DELEGATE_TOOL_NAME ? "委派 Agent" : undefined,
        preResolveCalls: this.spawnSubagentsHook({
          tenantId,
          agent,
          nameMap,
          childDepth: 1,
          parentSessionId: sessionId,
          parentRunId: runId,
          isCancelled: () => this.store.isCancelRequested(runId),
        }),
        // 跨 Agent 委派：目标 Agent 名下创建 delegate 会话并运行
        interceptCall: async (call, args) => {
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
      },
    });

    if (result.status === "cancelled") return;

    // —— 运行后处理（不阻塞会话）：自动标题 + 自动记忆 ——
    void this.postRun({
      tenantId,
      agent,
      sessionId,
      runId,
      cloud,
      isFirstTurn: input.isFirstTurn,
      userContent: lastUserContent,
      assistantContent: result.finalText,
      resolvedMemory: autoMemoryOn ? resolvedMemory : null,
    }).catch((err) => {
      console.warn("[cloud-agent] post-run failed:", err);
    });
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
    const messages: ModelChatMessage[] = [
      {
        role: "system",
        content: buildSubagentPrompt(agent, cloud, {
          expectedOutput: expected || undefined,
          subagents: canSpawn,
          skills: subagentSkills || undefined,
        }),
      },
      { role: "user", content: userContent },
    ];

    /** 本级 + 祖先链的取消检查（传给下一级子代理，逐级组合） */
    const isCancelledChain = async (): Promise<boolean> =>
      (await this.store.isCancelRequested(run.id)) ||
      (opts.isCancelled ? await opts.isCancelled() : false);

    try {
      const result = await runAgentLoop(this.loopDeps, {
        tenantId,
        agent,
        cloud,
        sessionId: session.id,
        runId: run.id,
        messages,
        definitions,
        nameMap,
        maxRounds: 16,
        maxRoundsNote: (max, lastText) =>
          `子代理达到轮次上限（${max}），任务可能未完成。${
            lastText ? `最后进展：${lastText.slice(0, 2000)}` : "建议缩小任务范围后重新派生。"
          }`,
        ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
        ...(canSpawn
          ? {
              hooks: {
                preResolveCalls: this.spawnSubagentsHook({
                  tenantId,
                  agent,
                  nameMap,
                  childDepth: depth + 1,
                  parentSessionId: session.id,
                  parentRunId: run.id,
                  isCancelled: isCancelledChain,
                }),
              },
            }
          : {}),
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
          console.warn("[cloud-agent] failed to record subagent error:", e);
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
      const result = await runAgentLoop(this.loopDeps, {
        tenantId,
        agent: target,
        cloud: targetCloud,
        sessionId: session.id,
        runId: run.id,
        messages,
        definitions,
        nameMap,
        maxRounds: 12,
        maxRoundsNote: (max) => `达到委派轮次上限（${max}），任务可能未完成。`,
        isCancelled: opts.isCancelled,
        // 目标 Agent 在委派中派生子代理：同样并行执行、记录链接、传导取消
        hooks: {
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
          console.warn("[cloud-agent] failed to record delegate error:", e);
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
          { capability: "chat", ...(cloud.model ? { alias: cloud.model } : {}) },
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
}
