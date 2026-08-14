/**
 * 统一 Agent 循环引擎：主对话、子代理、跨 Agent 委派共用同一实现。
 *
 * 每次执行都绑定一个（会话, Run）：流式增量、工具调用、状态与日志
 * 全部落库为事件——任何类型的会话都可经同一 SSE 通道实时观看、事后回放。
 * 差异（上下文构建、工具面、提示词、轮次上限、特殊工具处理）全部由调用方
 * 通过输入与 hooks 注入，引擎本身不区分「谁在跑」。
 */
import { recordPlatformFault } from "@zakura/core";
import type {
  CloudAgentConfig,
  CloudAgentEventType,
  CloudAgentRunOptions,
  ModelChatMessage,
  ModelToolCall,
  ModelToolDefinition,
} from "@zakura/shared";
import type { Agent } from "../../db/schema.js";
import { newId } from "../../db/schema.js";
import type { McpGateway } from "../mcp-gateway.js";
import type { ModelRouterService } from "../model-router.js";
import type { CloudAgentSessionStore } from "../cloud-agent-session.js";
import { isAbortError } from "../../model-router/http.js";
import {
  estimateRequestTokens,
  applyTokenCalibration,
  type TokenCalibration,
} from "@zakura/shared";
import {
  compactToolResultsInPlace,
  buildUserMessage,
  isContextOverflowError,
  type CompactBudget,
} from "./messages.js";
import { mcpResultToText, parseToolArgs } from "./tools.js";

/** 取消标记兜底轮询间隔：pub/sub 丢失时最长这么久也会掐断 */
const CANCEL_POLL_MS = 500;

/**
 * 把会话队列中 mode=steer 的项写入模型上下文，并落库 user_message(steer)
 * 供时间线展示；随后广播队列快照（store 内部完成），多设备同步移除。
 */
async function injectPendingSteers(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  messages: ModelChatMessage[],
): Promise<number> {
  const items = await store.drainSteerQueued(sessionId);
  for (const item of items) {
    await store.appendEvent({
      sessionId,
      type: "user_message",
      runId,
      payload: {
        messageId: item.messageId,
        content: item.content,
        steer: true,
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
      },
    });
    messages.push(buildUserMessage(item.content, item.attachments ?? []));
  }
  return items.length;
}

/**
 * 取消观察器：监听即时取消信号 + 兜底轮询完整取消链（含祖先 Run）。
 * 用于与慢工具调用赛跑——取消后不再等工具结果，立刻收尾。
 */
function watchCancel(
  cancelPromise: Promise<void>,
  cancelled: () => Promise<boolean>,
): { hit: Promise<"cancelled">; dispose: () => void } {
  let disposed = false;
  let resolveHit: (v: "cancelled") => void = () => {};
  const hit = new Promise<"cancelled">((resolve) => {
    resolveHit = resolve;
  });
  void cancelPromise.then(() => {
    if (!disposed) resolveHit("cancelled");
  });
  const timer = setInterval(() => {
    void cancelled().then(
      (yes) => {
        if (yes && !disposed) resolveHit("cancelled");
      },
      () => {},
    );
  }, CANCEL_POLL_MS);
  return {
    hit,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

export type AgentLoopDeps = {
  store: CloudAgentSessionStore;
  modelRouter: ModelRouterService;
  gateway: McpGateway;
};

/** 工具调用派生的子会话链接（子代理/委派），随 tool_call_result 事件发布 */
export type LoopChildLink = { sessionId: string; agentId: string };

/** 特殊工具执行结果：结果本体 + 可选子会话链接 */
export type LoopToolOutcome = { result: unknown; link?: LoopChildLink };

export type AgentLoopHooks = {
  /**
   * 顺序执行前并行预解析部分调用（键为 toolCallId）。
   * 主循环用它把同一轮内的多个子代理调用并行执行。
   */
  preResolveCalls?: (calls: ModelToolCall[]) => Promise<Map<string, LoopToolOutcome>>;
  /** 拦截单个调用（如 delegate_to_agent）；返回 undefined 则走 MCP gateway */
  interceptCall?: (
    call: ModelToolCall,
    args: Record<string, unknown>,
  ) => Promise<LoopToolOutcome | undefined>;
  /** 工具成功/失败后回调（插件 PostToolUse / PostToolUseFailure）；返回文本则注入下一轮上下文 */
  afterToolCall?: (
    call: ModelToolCall,
    args: Record<string, unknown>,
    outcome: { resultText: string; isError: boolean },
  ) => Promise<string | void>;
  /** 模型准备结束本回合（无工具调用）时；block 则注入上下文并继续循环 */
  beforeStop?: (
    lastText: string,
  ) => Promise<{ block?: boolean; injectText?: string } | void>;
  /** tool_call_start 的展示标题（缺省 = qualified 名） */
  toolTitle?: (modelName: string, qualified: string) => string | undefined;
  /**
   * 循环内上下文超硬阈值，或上游 context overflow 时：
   * 同步 LLM 摘要并**就地改写** messages（保留 system + recent turns）。
   * 返回 true 表示已压缩，调用方可重试模型。
   */
  compactInLoop?: (
    messages: ModelChatMessage[],
    reason?: "threshold" | "overflow",
  ) => Promise<boolean>;
};

export type AgentLoopInput = {
  tenantId: string;
  /** 工具执行身份（委派场景 = 目标 Agent） */
  agent: Agent;
  cloud: CloudAgentConfig;
  /** 本次用户触发 Run 的模型调用选项；不影响后台摘要/标题/记忆调用。 */
  options?: CloudAgentRunOptions;
  sessionId: string;
  runId: string;
  /** system + 上下文 + 本回合用户消息；引擎就地追加 assistant/tool 轮次 */
  messages: ModelChatMessage[];
  definitions: ModelToolDefinition[];
  nameMap: Map<string, string>;
  /** 缺省不限轮次：直到模型不再调用工具、取消或出错 */
  maxRounds?: number;
  /** 达到轮次上限时写入会话并返回的说明文本 */
  maxRoundsNote?: (maxRounds: number, lastText: string) => string;
  /** 额外取消信号（父 Run 取消传导给子会话）；引擎始终还会检查本 Run 的取消标记 */
  isCancelled?: () => Promise<boolean>;
  /** 循环内工具结果压缩预算（缺省用平台默认） */
  compactBudget?: Partial<CompactBudget>;
  hooks?: AgentLoopHooks;
  /**
   * 每轮模型调用前（注入 steer 后）：解析 workspace 图片等。
   * 主循环用它把中途附件转成多模态 parts。
   */
  beforeModelRound?: (messages: ModelChatMessage[]) => Promise<void>;
  /** 会话绑定项目时，shell 默认 cwd（调用方显式 working_dir 仍优先） */
  defaultWorkingDir?: string;
  /** 会话绑定的项目 slug，供技能工具读取项目级 SKILL.md */
  projectSlug?: string;
};

export type AgentLoopResult = {
  status: "completed" | "cancelled" | "max_rounds";
  finalText: string;
  rounds: number;
};

/** 增量文本发布器：首字节立即刷出，随后按帧合并，避免思考/正文卡在缓冲区 */
export class DeltaPublisher {
  private buf = "";
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emittedAny = false;
  /** 首包已刷出前为 true，保证 TTFT 不被批处理拖住 */
  private firstPending = true;

  constructor(
    private readonly store: CloudAgentSessionStore,
    private readonly sessionId: string,
    private readonly runId: string,
    readonly messageId: string,
    private readonly eventType: Extract<
      CloudAgentEventType,
      "assistant_delta" | "reasoning_delta"
    > = "assistant_delta",
  ) {}

  get emitted(): boolean {
    return this.emittedAny;
  }

  push(text: string): void {
    if (!text) return;
    this.emittedAny = true;
    this.buf += text;
    // 首字节立刻推 SSE；之后 ~1 帧合并，降低 Redis/DB 压力
    if (this.firstPending) {
      this.firstPending = false;
      this.flush();
      return;
    }
    if (this.buf.length >= 48) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 16);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const chunk = this.buf;
    this.buf = "";
    if (!chunk) return;
    this.chain = Promise.all([
      this.chain,
      this.store
        .appendEvent({
          sessionId: this.sessionId,
          type: this.eventType,
          runId: this.runId,
          payload: { messageId: this.messageId, delta: chunk },
        })
        .catch((err) => {
          recordPlatformFault("cloud_agent.delta_publish", err, {
            subsystem: "cloud_agent",
          });
        }),
    ]);
  }

  async drain(): Promise<void> {
    this.flush();
    await this.chain;
  }
}

/** run_log 事件（失败不抛出，日志不阻断循环） */
export async function appendRunLog(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await store.appendEvent({
      sessionId,
      type: "run_log",
      runId,
      payload: { runId, level, message, ...(data ? { data } : {}) },
    });
  } catch (err) {
    recordPlatformFault("cloud_agent.run_log", err, { subsystem: "cloud_agent" });
  }
}

/** 统一失败收尾：run_error + run_end(failed) + Run 状态落库 */
export async function failRun(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
  message: string,
): Promise<void> {
  await store.appendEvent({
    sessionId,
    type: "run_error",
    runId,
    payload: { runId, message },
  });
  await store.appendEvent({
    sessionId,
    type: "run_end",
    runId,
    payload: { runId, status: "failed" },
  });
  await store.finishRun(sessionId, runId, "failed", message);
}

async function finishCancelled(
  store: CloudAgentSessionStore,
  sessionId: string,
  runId: string,
): Promise<void> {
  await store.appendEvent({
    sessionId,
    type: "run_status",
    runId,
    payload: { runId, status: "cancelled", detail: "已取消" },
  });
  await store.appendEvent({
    sessionId,
    type: "run_end",
    runId,
    payload: { runId, status: "cancelled" },
  });
  await store.finishRun(sessionId, runId, "cancelled");
}

/**
 * 单轮流式模型调用（带自愈重试）。
 * 模型路由层已做「未输出时」的同路由重试与故障转移；这里兜底处理
 * 剩下两类失败：全部路由瞬时失败（稍候整体重来）、流中断且已输出
 * 部分增量（发布 assistant_rollback 丢弃半截文本后换新 messageId 重来）。
 */
async function streamModelRound(
  deps: Pick<AgentLoopDeps, "store" | "modelRouter">,
  input: {
    tenantId: string;
    sessionId: string;
    runId: string;
    cloud: CloudAgentConfig;
    options?: CloudAgentRunOptions;
    messages: ModelChatMessage[];
    definitions: ModelToolDefinition[];
    /** 取消检查（本 Run 标记 + 祖先链）；兜底轮询命中即掐断上游流 */
    isCancelled: () => Promise<boolean>;
    /** 即时取消信号：requestCancel 触达的瞬间 abort，无需等轮询 */
    cancelPromise: Promise<void>;
    /** 上下文溢出时同步压缩 messages 并返回是否成功 */
    onContextOverflow?: (messages: ModelChatMessage[]) => Promise<boolean>;
  },
): Promise<{
  publisher: DeltaPublisher;
  reasoningPublisher: DeltaPublisher;
  result: Awaited<ReturnType<ModelRouterService["chatStream"]>>;
}> {
  const { tenantId, sessionId, runId, cloud, messages, definitions } = input;
  const maxAttempts = 3;
  let overflowCompactUsed = false;
  for (let attempt = 1; ; attempt += 1) {
    const messageId = newId();
    const publisher = new DeltaPublisher(deps.store, sessionId, runId, messageId);
    const reasoningPublisher = new DeltaPublisher(
      deps.store,
      sessionId,
      runId,
      messageId,
      "reasoning_delta",
    );
    // 即时信号优先；轮询只兜底 pub/sub 丢失的场景
    const ctrl = new AbortController();
    let roundDone = false;
    void input.cancelPromise.then(() => {
      if (!roundDone && !ctrl.signal.aborted) ctrl.abort();
    });
    const poll = setInterval(() => {
      void input.isCancelled().then(
        (yes) => {
          if (yes && !ctrl.signal.aborted) ctrl.abort();
        },
        () => {},
      );
    }, CANCEL_POLL_MS);
    try {
      const result = await deps.modelRouter.chatStream(
        tenantId,
        messages,
        {
          capability: "chat",
          ...(cloud.modelRouteId
            ? { routeId: cloud.modelRouteId }
            : cloud.model
              ? { alias: cloud.model }
              : {}),
        },
        definitions.length
          ? {
              tools: definitions,
              toolChoice: "auto",
              ...(input.options?.reasoning
                ? { routeOptions: { reasoning: input.options.reasoning } }
                : {}),
            }
          : input.options?.reasoning
            ? { routeOptions: { reasoning: input.options.reasoning } }
            : undefined,
        {
          onDelta: (text) => publisher.push(text),
          onReasoningDelta: (text) => reasoningPublisher.push(text),
          signal: ctrl.signal,
        },
      );
      await publisher.drain();
      await reasoningPublisher.drain();
      return { publisher, reasoningPublisher, result };
    } catch (err) {
      await publisher.drain();
      await reasoningPublisher.drain();
      // 取消引发的中断：直接抛出，由 runAgentLoop 走取消收尾（不重试）
      if (isAbortError(err) || ctrl.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);

      // 上下文超长：同步压缩后重试一轮（整次 streamModelRound 仅一次）
      if (
        !overflowCompactUsed &&
        isContextOverflowError(err) &&
        input.onContextOverflow
      ) {
        overflowCompactUsed = true;
        if (publisher.emitted || reasoningPublisher.emitted) {
          await deps.store.appendEvent({
            sessionId,
            type: "assistant_rollback",
            runId,
            payload: { messageId: publisher.messageId, reason: "context_overflow" },
          });
        }
        await appendRunLog(
          deps.store,
          sessionId,
          runId,
          "warn",
          "上下文超长，正在同步压缩后重试",
          { error: message.slice(0, 400) },
        );
        try {
          const ok = await input.onContextOverflow(messages);
          if (ok) {
            attempt = 0; // 下一轮 for 会 +1 → 1，相当于溢出后重新计数
            continue;
          }
        } catch (compactErr) {
          await appendRunLog(
            deps.store,
            sessionId,
            runId,
            "warn",
            "溢出后压缩失败",
            {
              error:
                compactErr instanceof Error ? compactErr.message : String(compactErr),
            },
          );
        }
        throw err;
      }

      const retryable = (err as { retryable?: boolean }).retryable === true;
      if (!retryable || attempt >= maxAttempts) throw err;
      if (await input.isCancelled()) throw err;
      if (publisher.emitted || reasoningPublisher.emitted) {
        await deps.store.appendEvent({
          sessionId,
          type: "assistant_rollback",
          runId,
          payload: { messageId: publisher.messageId, reason: "stream_interrupted" },
        });
      }
      await appendRunLog(
        deps.store,
        sessionId,
        runId,
        "warn",
        `模型调用中断，正在重试（第 ${attempt}/${maxAttempts - 1} 次）`,
        { error: message.slice(0, 600) },
      );
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally {
      roundDone = true;
      clearInterval(poll);
    }
  }
}

export async function runAgentLoop(
  deps: AgentLoopDeps,
  input: AgentLoopInput,
): Promise<AgentLoopResult> {
  const { store } = deps;
  const { tenantId, agent, cloud, options, sessionId, runId, messages, definitions, nameMap } = input;

  // 即时取消：requestCancel（本实例或经 Redis 频道跨实例）触达瞬间掐流/弃工具，
  // DB 标记只作兜底轮询。监听器在 finally 注销。
  let cancelSignalled = false;
  let signalCancel: () => void = () => {};
  const cancelPromise = new Promise<void>((resolve) => {
    signalCancel = () => {
      cancelSignalled = true;
      resolve();
    };
  });
  const offCancel = store.onRunCancel(runId, signalCancel);

  const cancelled = async (): Promise<boolean> =>
    cancelSignalled ||
    (await store.isCancelRequested(runId)) ||
    (input.isCancelled ? await input.isCancelled() : false);

  try {
    let lastText = "";
    let round = 0;
    let stopBlocks = 0;
    /** 用上游 prompt_tokens 校准后续体积判断 */
    let tokenCal: TokenCalibration | null = null;
    while (true) {
      if (await cancelled()) {
        await finishCancelled(store, sessionId, runId);
        return { status: "cancelled", finalText: lastText, rounds: round };
      }

      // round 0 的 thinking 已在 executeRun 发出；此处只推后续轮的 streaming，避免同步落库挡首字
      if (round > 0) {
        void store.appendEvent({
          sessionId,
          type: "run_status",
          runId,
          payload: { runId, status: "streaming" },
        });
      }

      try {
        await input.beforeModelRound?.(messages);
      } catch (err) {
        recordPlatformFault("cloud_agent.before_model_round", err, {
          subsystem: "cloud_agent",
        });
      }

      const roundStarted = Date.now();
      let publisher: DeltaPublisher;
      let result: Awaited<ReturnType<ModelRouterService["chatStream"]>>;
      try {
        ({ publisher, result } = await streamModelRound(deps, {
          tenantId,
          sessionId,
          runId,
          cloud,
          messages,
          definitions,
          isCancelled: cancelled,
          cancelPromise,
          ...(options ? { options } : {}),
          ...(input.hooks?.compactInLoop
            ? {
                onContextOverflow: (msgs) =>
                  input.hooks!.compactInLoop!(msgs, "overflow"),
              }
            : {}),
        }));
      } catch (err) {
        // 取消掐断的流：收尾为 cancelled 而非 failed（错误不是故障）
        if (isAbortError(err) || (await cancelled())) {
          await finishCancelled(store, sessionId, runId);
          return { status: "cancelled", finalText: lastText, rounds: round };
        }
        throw err;
      }

      const toolCalls = result.toolCalls ?? [];
      const text = result.content ?? "";
      if (text) lastText = text;

      // 记录本轮请求体积：估算 + 上游 measured，供校准与 run_log
      const estimatedPrompt = estimateRequestTokens({
        messages,
        tools: definitions,
      });
      const measuredPrompt =
        typeof result.usage?.promptTokens === "number" && result.usage.promptTokens > 0
          ? result.usage.promptTokens
          : undefined;
      if (measuredPrompt != null) {
        tokenCal = {
          measuredPromptTokens: measuredPrompt,
          estimatedAtMeasure: estimatedPrompt,
        };
      }
      const calibratedPrompt = applyTokenCalibration(estimatedPrompt, tokenCal);

      await appendRunLog(store, sessionId, runId, "info", `第 ${round + 1} 轮模型调用完成`, {
        model: result.model,
        route: result.routeSlug,
        durationMs: Date.now() - roundStarted,
        toolCalls: toolCalls.length,
        estimatedPromptTokens: estimatedPrompt,
        calibratedPromptTokens: calibratedPrompt,
        ...(result.usage
          ? {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            }
          : {}),
        ...(tokenCal
          ? {
              calibrationRatio: Number(
                (tokenCal.measuredPromptTokens / tokenCal.estimatedAtMeasure).toFixed(3),
              ),
            }
          : {}),
      });

      if (toolCalls.length === 0) {
        // 先落本轮助手正文，再决定是结束还是吞入 steer 继续
        await store.appendEvent({
          sessionId,
          type: "assistant_message",
          runId,
          payload: { messageId: publisher.messageId, content: text },
        });
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        const steered = await injectPendingSteers(store, sessionId, runId, messages);
        if (steered > 0) {
          await appendRunLog(store, sessionId, runId, "info", "结束前注入用户补充", {
            count: steered,
          });
          round += 1;
          continue;
        }
        let stop: { block?: boolean; injectText?: string } | void = undefined;
        try {
          stop = await input.hooks?.beforeStop?.(text);
        } catch (err) {
          recordPlatformFault("cloud_agent.before_stop", err, { subsystem: "cloud_agent" });
        }
        if (stop?.injectText?.trim()) {
          messages.push({
            role: "system",
            content: `# Hooks · Stop\n${stop.injectText.trim()}`,
          });
        }
        if (stop?.block && stopBlocks < 8) {
          stopBlocks += 1;
          await appendRunLog(store, sessionId, runId, "info", "Stop hook 拦住结束，继续本回合", {
            blocks: stopBlocks,
          });
          round += 1;
          continue;
        }
        await store.appendEvent({
          sessionId,
          type: "run_end",
          runId,
          payload: { runId, status: "completed" },
        });
        await store.finishRun(sessionId, runId, "completed");
        return { status: "completed", finalText: text, rounds: round + 1 };
      }

      // 有工具调用：增量文本已作为 delta 发布，与 tool_call_* 合成同一条 assistant
      messages.push({
        role: "assistant",
        content: text || null,
        toolCalls,
      });

      for (const call of toolCalls) {
        const modelName = call.function.name;
        const qualified = nameMap.get(modelName) ?? modelName;
        await store.appendEvent({
          sessionId,
          type: "tool_call_start",
          runId,
          payload: {
            toolCallId: call.id,
            name: modelName,
            title: input.hooks?.toolTitle?.(modelName, qualified) ?? qualified,
          },
        });
        await store.appendEvent({
          sessionId,
          type: "tool_call_args",
          runId,
          payload: {
            toolCallId: call.id,
            arguments: call.function.arguments,
          },
        });
      }

      // 特殊调用的批量预解析（如同一轮内多个子代理并行执行）
      let preResolved = new Map<string, LoopToolOutcome>();
      if (input.hooks?.preResolveCalls) {
        preResolved = await input.hooks.preResolveCalls(toolCalls);
      }

      /** 取消时补发未完成工具的结果，先于 run_end 落库，避免 UI 一直转圈 */
      const abandonRemaining = async (from: number): Promise<void> => {
        const rest = toolCalls.slice(from);
        if (rest.length === 0) return;
        await Promise.all(
          rest.map((call) =>
            store.appendEvent({
              sessionId,
              type: "tool_call_result",
              runId,
              payload: {
                toolCallId: call.id,
                name: call.function.name,
                isError: true,
                resultText: "（已取消：该工具调用未执行）",
                durationMs: 0,
              },
            }),
          ),
        ).catch((err) =>
          recordPlatformFault("cloud_agent.abandon_remaining", err, {
            subsystem: "cloud_agent",
          }),
        );
      };

      for (const [index, call] of toolCalls.entries()) {
        if (await cancelled()) {
          await abandonRemaining(index);
          await finishCancelled(store, sessionId, runId);
          return { status: "cancelled", finalText: lastText, rounds: round + 1 };
        }

        const modelName = call.function.name;
        const qualified = nameMap.get(modelName) ?? modelName;
        await store.appendEvent({
          sessionId,
          type: "run_status",
          runId,
          payload: { runId, status: "tool", detail: modelName },
        });

        const started = Date.now();
        const args = parseToolArgs(call.function.arguments);
        // 工具执行与取消赛跑：取消后不再等慢工具的结果（其进程可能继续到自然结束）
        const watcher = watchCancel(cancelPromise, cancelled);
        let raced:
          | { kind: "ok"; outcome: LoopToolOutcome }
          | { kind: "err"; err: unknown }
          | "cancelled";
        try {
          raced = await Promise.race([
            (async () => {
              try {
                const resolved =
                  preResolved.get(call.id) ??
                  (await input.hooks?.interceptCall?.(call, args));
                const outcome = resolved ?? {
                  result: await deps.gateway.callTool(tenantId, qualified, args, {
                    agentId: agent.id,
                    ...(input.defaultWorkingDir
                      ? { defaultWorkingDir: input.defaultWorkingDir }
                      : {}),
                    ...(input.projectSlug ? { projectSlug: input.projectSlug } : {}),
                    onProgress: (message, data) => {
                      const stdout =
                        data && typeof data.stdout === "string" ? data.stdout : undefined;
                      const stderr =
                        data && typeof data.stderr === "string" ? data.stderr : undefined;
                      const jobId =
                        data && typeof data.jobId === "string" ? data.jobId : undefined;
                      const running =
                        data && typeof data.running === "boolean" ? data.running : undefined;
                      void store.appendEvent({
                        sessionId,
                        type: "tool_call_progress",
                        runId,
                        payload: {
                          toolCallId: call.id,
                          message,
                          ...(stdout != null ? { stdout } : {}),
                          ...(stderr != null ? { stderr } : {}),
                          ...(jobId ? { jobId } : {}),
                          ...(running != null ? { running } : {}),
                        },
                      });
                    },
                  }),
                };
                return { kind: "ok" as const, outcome };
              } catch (err) {
                return { kind: "err" as const, err };
              }
            })(),
            watcher.hit,
          ]);
        } finally {
          watcher.dispose();
        }

        if (raced === "cancelled") {
          const note = "（已取消：不再等待该工具结果）";
          void store.appendEvent({
            sessionId,
            type: "tool_call_result",
            runId,
            payload: {
              toolCallId: call.id,
              name: modelName,
              isError: true,
              resultText: note,
              durationMs: Date.now() - started,
            },
          });
          await abandonRemaining(index + 1);
          await finishCancelled(store, sessionId, runId);
          return { status: "cancelled", finalText: lastText, rounds: round + 1 };
        }

        let outcome: LoopToolOutcome;
        if (raced.kind === "err") {
          const err = raced.err;
          // 取消引发的工具中断：补齐剩余调用后整体收尾为 cancelled
          if (isAbortError(err) || (await cancelled())) {
            await abandonRemaining(index);
            await finishCancelled(store, sessionId, runId);
            return { status: "cancelled", finalText: lastText, rounds: round + 1 };
          }
          outcome = {
            result: {
              content: [
                { type: "text", text: err instanceof Error ? err.message : String(err) },
              ],
              isError: true,
            },
          };
        } else {
          outcome = raced.outcome;
        }
        const { text: resultText, isError } = mcpResultToText(outcome.result);
        const durationMs = Date.now() - started;

        await store.appendEvent({
          sessionId,
          type: "tool_call_result",
          runId,
          payload: {
            toolCallId: call.id,
            name: modelName,
            isError,
            resultText,
            durationMs,
            ...(outcome.link
              ? { childSessionId: outcome.link.sessionId, childAgentId: outcome.link.agentId }
              : {}),
          },
        });

        let hookInject = "";
        try {
          hookInject = (await input.hooks?.afterToolCall?.(call, args, { resultText, isError })) ?? "";
        } catch (err) {
          recordPlatformFault("cloud_agent.after_tool_call", err, {
            subsystem: "cloud_agent",
          });
        }

        messages.push({
          role: "tool",
          content: resultText,
          toolCallId: call.id,
          name: modelName,
        });
        if (hookInject.trim()) {
          messages.push({
            role: "system",
            content: `# Hooks · ${isError ? "PostToolUseFailure" : "PostToolUse"}\n${hookInject.trim()}`,
          });
        }
      }

      // Codex 式：工具批结束后注入排队的用户补充，再进下一轮模型
      const steered = await injectPendingSteers(store, sessionId, runId, messages);
      if (steered > 0) {
        await appendRunLog(store, sessionId, runId, "info", "工具后注入用户补充", {
          count: steered,
        });
      }

      // 循环内上下文过大：先分级就地压工具结果，仍超 token 硬阈值则同步 LLM 摘要
      const compacted = compactToolResultsInPlace(messages, input.compactBudget);
      if (compacted > 0) {
        await appendRunLog(store, sessionId, runId, "info", "循环内压缩旧工具结果", {
          compacted,
        });
      }
      const estNow = estimateRequestTokens({ messages, tools: definitions });
      const sizeNow = applyTokenCalibration(estNow, tokenCal);
      const hardTokens = input.compactBudget?.thresholdTokens ?? 15_000;
      if (sizeNow > hardTokens && input.hooks?.compactInLoop) {
        try {
          const did = await input.hooks.compactInLoop(messages, "threshold");
          if (did) {
            await appendRunLog(store, sessionId, runId, "info", "循环内已同步摘要压缩上下文", {
              calibratedTokens: sizeNow,
              hardTokens,
            });
            tokenCal = null;
          }
        } catch (err) {
          await appendRunLog(store, sessionId, runId, "warn", "循环内同步摘要失败", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      round += 1;
      if (input.maxRounds != null && round >= input.maxRounds) {
        const note =
          input.maxRoundsNote?.(input.maxRounds, lastText) ??
          `已达到配置的最大工具轮次（${input.maxRounds}），请继续发送消息以接着处理。`;
        const messageId = newId();
        await store.appendEvent({
          sessionId,
          type: "assistant_delta",
          runId,
          payload: { messageId, delta: note },
        });
        await store.appendEvent({
          sessionId,
          type: "assistant_message",
          runId,
          payload: { messageId, content: note },
        });
        await store.appendEvent({
          sessionId,
          type: "run_end",
          runId,
          payload: { runId, status: "completed" },
        });
        await store.finishRun(sessionId, runId, "completed");
        return { status: "max_rounds", finalText: note, rounds: round };
      }
    }
  } finally {
    offCancel();
  }
}
