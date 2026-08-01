/**
 * 统一 Agent 循环引擎：主对话、子代理、跨 Agent 委派共用同一实现。
 *
 * 每次执行都绑定一个（会话, Run）：流式增量、工具调用、状态与日志
 * 全部落库为事件——任何类型的会话都可经同一 SSE 通道实时观看、事后回放。
 * 差异（上下文构建、工具面、提示词、轮次上限、特殊工具处理）全部由调用方
 * 通过输入与 hooks 注入，引擎本身不区分「谁在跑」。
 */
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
import { compactToolResultsInPlace } from "./messages.js";
import { mcpResultToText, parseToolArgs } from "./tools.js";

/** 取消标记轮询间隔：取消后最长这么久就会掐断上游流 */
const CANCEL_POLL_MS = 700;

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
  /** tool_call_start 的展示标题（缺省 = qualified 名） */
  toolTitle?: (modelName: string, qualified: string) => string | undefined;
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
  hooks?: AgentLoopHooks;
};

export type AgentLoopResult = {
  status: "completed" | "cancelled" | "max_rounds";
  finalText: string;
  rounds: number;
};

/** 增量文本发布器：合并小 delta，串行落库，避免每 token 一次事务 */
export class DeltaPublisher {
  private buf = "";
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emittedAny = false;

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
    if (this.buf.length >= 120) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 250);
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
    this.chain = this.chain
      .then(() =>
        this.store.appendEvent({
          sessionId: this.sessionId,
          type: this.eventType,
          runId: this.runId,
          payload: { messageId: this.messageId, delta: chunk },
        }),
      )
      .catch((err) => {
        console.warn("[cloud-agent] delta publish failed:", err);
      });
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
    console.warn("[cloud-agent] run_log failed:", err);
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
    /** 取消检查（本 Run 标记 + 祖先链）；轮询命中即掐断上游流 */
    isCancelled: () => Promise<boolean>;
  },
): Promise<{
  publisher: DeltaPublisher;
  reasoningPublisher: DeltaPublisher;
  result: Awaited<ReturnType<ModelRouterService["chatStream"]>>;
}> {
  const { tenantId, sessionId, runId, cloud, messages, definitions } = input;
  const maxAttempts = 3;
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
    // 流式期间轮询取消标记：命中则 abort，fetch 立即断开，不再等模型把话说完
    const ctrl = new AbortController();
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

  const cancelled = async (): Promise<boolean> =>
    (await store.isCancelRequested(runId)) ||
    (input.isCancelled ? await input.isCancelled() : false);

  let lastText = "";
  let round = 0;
  while (true) {
    if (await cancelled()) {
      await finishCancelled(store, sessionId, runId);
      return { status: "cancelled", finalText: lastText, rounds: round };
    }

    await store.appendEvent({
      sessionId,
      type: "run_status",
      runId,
      payload: { runId, status: round === 0 ? "thinking" : "streaming" },
    });

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
        ...(options ? { options } : {}),
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
    await appendRunLog(store, sessionId, runId, "info", `第 ${round + 1} 轮模型调用完成`, {
      model: result.model,
      route: result.routeSlug,
      durationMs: Date.now() - roundStarted,
      toolCalls: toolCalls.length,
      ...(result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          }
        : {}),
    });

    if (toolCalls.length === 0) {
      await store.appendEvent({
        sessionId,
        type: "assistant_message",
        runId,
        payload: { messageId: publisher.messageId, content: text },
      });
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

    /** 取消时为尚未执行的调用补发结果事件，避免 UI 里永远停在「运行中」 */
    const abandonRemaining = async (from: number): Promise<void> => {
      for (const call of toolCalls.slice(from)) {
        await store.appendEvent({
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
        });
        messages.push({
          role: "tool",
          content: "（已取消：该工具调用未执行）",
          toolCallId: call.id,
          name: call.function.name,
        });
      }
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
      let outcome: LoopToolOutcome;
      try {
        const resolved =
          preResolved.get(call.id) ?? (await input.hooks?.interceptCall?.(call, args));
        outcome = resolved ?? {
          result: await deps.gateway.callTool(tenantId, qualified, args, {
            agentId: agent.id,
          }),
        };
      } catch (err) {
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

      messages.push({
        role: "tool",
        content: resultText,
        toolCallId: call.id,
        name: modelName,
      });
    }

    // 循环内上下文过大：就地压缩较旧的工具结果
    const compacted = compactToolResultsInPlace(messages);
    if (compacted > 0) {
      await appendRunLog(store, sessionId, runId, "info", "循环内压缩旧工具结果", {
        compacted,
      });
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
}
