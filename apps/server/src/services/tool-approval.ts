/**
 * 工具调用审批服务（Codex / Claude Code 式）。
 *
 * 在 MCP gateway 执行工具前介入：
 * - 规则（deny/ask/allow，Claude 钩子匹配语法）与记住的允许/拒绝先行判定
 * - 策略默认值：allow_all（默认放行）/ ask（只读放行，其余询问）/ ai（AI 门控）
 * - AI 门控：TypeSafe System One（JEV choice 原语，返回概率与置信度）
 *   或传统 LLM（模型路由 + JSON 裁决）。置信度低于阈值升级人工。
 * - 人工审批：落库 + tool_approval_request 事件 + 阻塞等待，支持超时/取消。
 *
 * AI 调用失败时降级为人工审批（fail-safe，绝不静默放行）。
 */
import { and, eq, lte } from "drizzle-orm";
import type {
  CloudAgentToolApprovalOption,
  CloudAgentToolApprovalRequestPayload,
  CloudAgentToolApprovalResolvedPayload,
  McpToolAnnotations,
  ModelChatMessage,
  ModelEvaluationQuestion,
  ToolApprovalAiDecision,
  ToolApprovalAiGateConfig,
  ToolApprovalConfig,
  ToolApprovalReason,
} from "@zakura/shared";
import {
  inferToolAnnotations,
  resolveApprovalPolicy,
  resolveAskTimeoutSeconds,
  resolveConfidenceThreshold,
  approvalRuleHits,
} from "@zakura/shared";
import { recordPlatformFault } from "@zakura/core";
import type { Db } from "../db/client.js";
import type { Agent } from "../db/schema.js";
import { agentToolApprovals, agents, newId } from "../db/schema.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import type { ModelRouterService } from "./model-router.js";

export type ToolApprovalGateInput = {
  tenantId: string;
  agent: Agent;
  sessionId: string;
  runId: string;
  sessionKind?: string;
  toolCallId: string;
  /** 模型可见的工具名（如 re_shell_exec） */
  toolName: string;
  /** 限定名（如 workspace:re_shell_exec） */
  qualifiedName: string;
  args: Record<string, unknown>;
  argsJson: string;
  config?: ToolApprovalConfig;
  /** 最近一条用户消息（供 AI 门控判断意图，可缺省） */
  lastUserContent?: string;
};

export type ToolApprovalGateResult =
  | { action: "allow" }
  | { action: "deny"; message: string };

type Pending = { resolve: (decision: PendingDecision) => void };
type PendingDecision = "approved" | "denied" | "timeout" | "cancelled";

const TICK_MS = 5_000;
const ARGS_JSON_MAX = 6_000;
const CONTEXT_MAX = 4_000;
const JEV_TIMEOUT_MS = 12_000;
const JEV_RETRIES: Array<{ status: number[]; delayMs: number }> = [
  { status: [429, 529], delayMs: 600 },
  { status: [429, 529], delayMs: 1_800 },
];

const APPROVAL_OPTIONS: CloudAgentToolApprovalOption[] = [
  { optionId: "allow", name: "允许本次", kind: "allow_once" },
  { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
  { optionId: "deny", name: "拒绝", kind: "reject_once" },
];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（截断）`;
}

/* ------------------------------------------------------------------ */
/* TypeSafe System One（JEV）客户端                                     */
/* ------------------------------------------------------------------ */

type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
      confidence?: number;
    }
  | { type: "score"; score: number; confidence?: number };

type TypesafeResponse = {
  model?: string;
  answers?: Record<string, TypesafeAnswer>;
};

/** TypeSafe System One 评估端点客户端（POST /v1/systemone） */
export class TypesafeSystemOneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async evaluate(
    state: unknown,
    questions: Record<string, { type: string; instructions: string; criteria?: unknown }>,
    model: string,
  ): Promise<TypesafeResponse> {
    let lastErr: unknown = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request(state, questions, model);
      } catch (err) {
        lastErr = err;
        const retry =
          err instanceof TypesafeHttpError &&
          attempt < JEV_RETRIES.length &&
          JEV_RETRIES[attempt]!.status.includes(err.status);
        if (!retry) throw err;
        await new Promise((r) => setTimeout(r, JEV_RETRIES[attempt]!.delayMs));
      }
    }
    throw lastErr;
  }

  private async request(
    state: unknown,
    questions: Record<string, unknown>,
    model: string,
  ): Promise<TypesafeResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JEV_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state, model, questions }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new TypesafeHttpError(
          res.status,
          `TypeSafe API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        );
      }
      return (await res.json()) as TypesafeResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class TypesafeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TypesafeHttpError";
  }
}

/* ------------------------------------------------------------------ */
/* 审批服务                                                            */
/* ------------------------------------------------------------------ */

export class ToolApprovalService {
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly store: CloudAgentSessionStore,
    private readonly modelRouter: ModelRouterService | null,
  ) {}

  /** 工具注解读取（由运行时注入，基于 gateway 缓存；缺省按名字推断） */
  annotationsResolver:
    | ((agent: Agent, qualifiedName: string) => Promise<McpToolAnnotations | undefined>)
    | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 审批门：在 gateway.callTool 之前调用。
   * 返回 allow 放行；deny 时 message 会作为工具错误结果返回给模型。
   */
  async gate(input: ToolApprovalGateInput): Promise<ToolApprovalGateResult> {
    const config = input.config ?? {};
    const policy = resolveApprovalPolicy(config);
    const annotations = await this.resolveAnnotations(input.agent, input.qualifiedName);

    // 1) deny 规则 / 记住的拒绝
    const rules = config.rules ?? [];
    for (const rule of rules) {
      if (rule.action === "deny" && approvalRuleHits(rule.matcher, input.toolName, input.args)) {
        return { action: "deny", message: `审批规则拒绝该调用（${rule.matcher}）` };
      }
    }
    for (const matcher of config.alwaysDeny ?? []) {
      if (approvalRuleHits(matcher, input.toolName, input.args)) {
        return { action: "deny", message: "该工具此前被设置为总是拒绝" };
      }
    }

    // 2) 记住的允许
    for (const matcher of config.alwaysAllow ?? []) {
      if (approvalRuleHits(matcher, input.toolName, input.args)) return { action: "allow" };
    }

    // 3) ask 规则
    for (const rule of rules) {
      if (rule.action === "ask" && approvalRuleHits(rule.matcher, input.toolName, input.args)) {
        return this.askHuman(input, config, "rule_ask");
      }
    }

    // 4) allow 规则
    for (const rule of rules) {
      if (rule.action === "allow" && approvalRuleHits(rule.matcher, input.toolName, input.args)) {
        return { action: "allow" };
      }
    }

    // 5) 策略默认值
    if (policy === "allow_all") return { action: "allow" };
    if (policy === "ask") {
      if (annotations?.readOnlyHint === true) return { action: "allow" };
      return this.askHuman(input, config, "policy_ask");
    }

    // ai：AI 门控（JEV / 传统 LLM），失败降级人工
    const ai = await this.aiDecide(input, config);
    if (ai) {
      const threshold = resolveConfidenceThreshold(config);
      const chosen = ai.probabilities?.[ai.decision] ?? ai.confidence;
      const escalateOnDeny = config.aiGate?.escalateOnDeny !== false;
      if (ai.decision === "allow" && !ai.degraded && chosen >= threshold) {
        await this.recordAiDecision(input, "ai_auto", ai, "approved");
        return { action: "allow" };
      }
      if (ai.decision === "deny" && !ai.degraded && chosen >= threshold) {
        if (escalateOnDeny) {
          return this.askHuman(input, config, "ai_deny_escalate", ai);
        }
        await this.recordAiDecision(input, "ai_auto", ai, "denied");
        return { action: "deny", message: `AI 审批拒绝该调用（${Math.round(chosen * 100)}%）` };
      }
      // 低置信度 / AI 降级 → 人工复核
      return this.askHuman(input, config, ai.degraded ? "policy_ask" : "ai_low_confidence", ai);
    }
    // AI 不可用（未配置 provider）→ 人工
    return this.askHuman(input, config, "policy_ask");
  }

  /** AI 自动决策落审计行 + 发 request/resolved 事件对（UI 展示 AI 已决定） */
  private async recordAiDecision(
    input: ToolApprovalGateInput,
    reason: ToolApprovalReason,
    ai: ToolApprovalAiDecision,
    decision: "approved" | "denied",
  ): Promise<void> {
    const id = newId();
    const now = new Date();
    try {
      await this.db.insert(agentToolApprovals).values({
        id,
        tenantId: input.tenantId,
        agentId: input.agent.id,
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        qualifiedName: input.qualifiedName,
        argsJson: truncate(input.argsJson || "{}", ARGS_JSON_MAX),
        reason,
        aiJson: JSON.stringify(ai),
        status: decision,
        decidedBy: "ai",
        resolvedAt: now,
        createdAt: now,
      });
      const payload: CloudAgentToolApprovalRequestPayload = {
        requestId: id,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        qualifiedName: input.qualifiedName,
        argumentsJson: truncate(input.argsJson || "{}", ARGS_JSON_MAX),
        reason,
        ai,
        options: APPROVAL_OPTIONS,
        expiresAt: null,
      };
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "tool_approval_request",
        runId: input.runId,
        payload,
      });
      const resolved: CloudAgentToolApprovalResolvedPayload = {
        requestId: id,
        toolCallId: input.toolCallId,
        decision,
        decidedBy: "ai",
      };
      await this.store.appendEvent({
        sessionId: input.sessionId,
        type: "tool_approval_resolved",
        runId: input.runId,
        payload: resolved,
      });
    } catch (err) {
      recordPlatformFault("tool_approval.record_ai_decision", err, {
        subsystem: "tool_approval",
      });
    }
  }

  /** 用户在审批卡上点允许 / 拒绝 */
  async resolve(
    tenantId: string,
    agentId: string,
    sessionId: string,
    input: {
      requestId: string;
      decision: "approved" | "denied";
      alwaysAllow?: boolean;
      cancelled?: boolean;
    },
  ): Promise<void> {
    const row = await this.db.query.agentToolApprovals.findFirst({
      where: and(
        eq(agentToolApprovals.id, input.requestId),
        eq(agentToolApprovals.sessionId, sessionId),
        eq(agentToolApprovals.tenantId, tenantId),
        eq(agentToolApprovals.agentId, agentId),
      ),
    });
    if (!row || row.status !== "pending") throw new Error("没有等待中的审批");
    const decision: PendingDecision = input.cancelled ? "cancelled" : input.decision;
    await this.settle(row, decision, {
      alwaysAllow: decision === "approved" && input.alwaysAllow === true,
    });
  }

  async cancelRun(runId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(agentToolApprovals)
      .where(and(eq(agentToolApprovals.runId, runId), eq(agentToolApprovals.status, "pending")));
    for (const row of rows) {
      await this.settle(row, "cancelled");
    }
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let n = 0;
    try {
      const now = new Date();
      const due = await this.db
        .select()
        .from(agentToolApprovals)
        .where(
          and(
            eq(agentToolApprovals.status, "pending"),
            lte(agentToolApprovals.expiresAt, now),
          ),
        )
        .limit(50);
      for (const row of due) {
        await this.settle(row, "timeout");
        n += 1;
      }
    } catch (err) {
      recordPlatformFault("tool_approval.tick", err, { subsystem: "tool_approval" });
    } finally {
      this.ticking = false;
    }
    return n;
  }

  /* ---------------- 内部：人工审批 ---------------- */

  private async askHuman(
    input: ToolApprovalGateInput,
    config: ToolApprovalConfig,
    reason: ToolApprovalReason,
    ai?: ToolApprovalAiDecision,
  ): Promise<ToolApprovalGateResult> {
    const timeoutSeconds = resolveAskTimeoutSeconds(config);
    const now = new Date();
    const expiresAt =
      timeoutSeconds != null ? new Date(now.getTime() + timeoutSeconds * 1000) : null;

    const id = newId();
    await this.db.insert(agentToolApprovals).values({
      id,
      tenantId: input.tenantId,
      agentId: input.agent.id,
      sessionId: input.sessionId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      qualifiedName: input.qualifiedName,
      argsJson: truncate(input.argsJson || "{}", ARGS_JSON_MAX),
      reason,
      aiJson: ai ? JSON.stringify(ai) : "{}",
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const payload: CloudAgentToolApprovalRequestPayload = {
      requestId: id,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      qualifiedName: input.qualifiedName,
      argumentsJson: truncate(input.argsJson || "{}", ARGS_JSON_MAX),
      reason,
      ...(ai ? { ai } : {}),
      options: APPROVAL_OPTIONS,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "tool_approval_request",
      runId: input.runId,
      payload,
    });

    const decision = await this.wait(id, input.runId, expiresAt);
    if (decision === "approved") return { action: "allow" };
    if (decision === "timeout") {
      return { action: "deny", message: "审批超时：用户未在期限内确认，已拒绝该调用" };
    }
    return { action: "deny", message: "用户拒绝了该工具调用" };
  }

  private wait(id: string, runId: string, expiresAt: Date | null): Promise<PendingDecision> {
    return new Promise((resolve) => {
      const finish = (value: PendingDecision) => {
        uncancel();
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, { resolve: finish });
      const uncancel = this.store.onRunCancel(runId, () => {
        void (async () => {
          const row = await this.db.query.agentToolApprovals.findFirst({
            where: eq(agentToolApprovals.id, id),
          });
          if (row && row.status === "pending") await this.settle(row, "cancelled");
        })().catch((err) =>
          recordPlatformFault("tool_approval.wait_cancel", err, {
            subsystem: "tool_approval",
          }),
        );
      });
      const ms = expiresAt ? expiresAt.getTime() - Date.now() : 0;
      if (expiresAt && ms <= 0) {
        void (async () => {
          const row = await this.db.query.agentToolApprovals.findFirst({
            where: eq(agentToolApprovals.id, id),
          });
          if (row && row.status === "pending") await this.settle(row, "timeout");
        })();
      }
      const timer =
        expiresAt && ms > 0
          ? setTimeout(() => {
              void (async () => {
                const row = await this.db.query.agentToolApprovals.findFirst({
                  where: eq(agentToolApprovals.id, id),
                });
                if (row && row.status === "pending") await this.settle(row, "timeout");
              })();
            }, ms + 20)
          : null;
    });
  }

  private async settle(
    row: typeof agentToolApprovals.$inferSelect,
    decision: PendingDecision,
    opts: { alwaysAllow?: boolean } = {},
  ): Promise<void> {
    if (row.status !== "pending") return;
    const decidedBy: CloudAgentToolApprovalResolvedPayload["decidedBy"] =
      decision === "timeout"
        ? "timeout"
        : decision === "cancelled"
          ? "cancel"
          : "user";
    await this.db
      .update(agentToolApprovals)
      .set({
        status: decision === "approved" ? "approved" : decision,
        decidedBy,
        alwaysAllow: opts.alwaysAllow === true,
        resolvedAt: new Date(),
      })
      .where(eq(agentToolApprovals.id, row.id));

    await this.store.appendEvent({
      sessionId: row.sessionId,
      type: "tool_approval_resolved",
      runId: row.runId,
      payload: {
        requestId: row.id,
        toolCallId: row.toolCallId ?? undefined,
        decision,
        decidedBy,
        ...(opts.alwaysAllow ? { alwaysAllow: true } : {}),
      },
    });

    const pending = this.pending.get(row.id);
    if (pending) {
      pending.resolve(decision);
      this.pending.delete(row.id);
    }

    if (opts.alwaysAllow && row.qualifiedName) {
      await this.persistAlwaysAllow(row.tenantId, row.agentId, row.qualifiedName).catch((err) =>
        recordPlatformFault("tool_approval.persist_always_allow", err, {
          subsystem: "tool_approval",
        }),
      );
    }
  }

  private async persistAlwaysAllow(
    tenantId: string,
    agentId: string,
    qualifiedName: string,
  ): Promise<void> {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) return;
    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(agent.configJson || "{}") as Record<string, unknown>;
    } catch {
      configJson = {};
    }
    const cloud =
      configJson.cloud && typeof configJson.cloud === "object" && !Array.isArray(configJson.cloud)
        ? (configJson.cloud as Record<string, unknown>)
        : {};
    const approvals =
      cloud.approvals && typeof cloud.approvals === "object" && !Array.isArray(cloud.approvals)
        ? (cloud.approvals as Record<string, unknown>)
        : {};
    const list = Array.isArray(approvals.alwaysAllow)
      ? (approvals.alwaysAllow as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!list.includes(qualifiedName)) list.push(qualifiedName);
    approvals.alwaysAllow = list;
    cloud.approvals = approvals;
    configJson.cloud = cloud;
    await this.db
      .update(agents)
      .set({ configJson: JSON.stringify(configJson) })
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
  }

  /* ---------------- 内部：AI 门控 ---------------- */

  private async aiDecide(
    input: ToolApprovalGateInput,
    config: ToolApprovalConfig,
  ): Promise<ToolApprovalAiDecision | null> {
    const gate = config.aiGate ?? {};
    const provider = gate.provider ?? (gate.llmModel ? "llm" : "jev");
    const started = Date.now();
    try {
      const state = this.buildState(input);
      const decision =
        provider === "jev"
          ? await this.decideWithJev(input, state, gate)
          : await this.decideWithLlm(input, state, gate.llmModel);
      if (!decision) return null;
      return { ...decision, provider, latencyMs: Date.now() - started };
    } catch (err) {
      recordPlatformFault("tool_approval.ai_gate", err, { subsystem: "tool_approval" });
      // fail-safe：AI 失败降级人工，绝不静默放行
      return {
        provider,
        model: provider === "jev" ? (gate.jevModel ?? "jev-latest") : (gate.llmModel ?? ""),
        decision: "deny",
        confidence: 0,
        degraded: true,
        rationale: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  private buildState(input: ToolApprovalGateInput): Record<string, unknown> {
    return {
      agent: input.agent.name,
      user_task: truncate(input.lastUserContent ?? "", CONTEXT_MAX),
      tool: {
        name: input.qualifiedName,
        model_name: input.toolName,
        ...(input.argsJson ? { arguments: JSON.parse(truncate(input.argsJson, ARGS_JSON_MAX)) } : {}),
      },
    };
  }

  private async decideWithJev(
    input: ToolApprovalGateInput,
    state: Record<string, unknown>,
    gate: ToolApprovalAiGateConfig,
  ): Promise<Omit<ToolApprovalAiDecision, "provider" | "latencyMs"> | null> {
    const questions: Record<string, ModelEvaluationQuestion> = {
      approval: {
        type: "choice",
        instructions:
          "An agent wants to execute this tool call. Decide whether it should be allowed, given the user task and the tool arguments. Deny destructive, out-of-scope, or clearly harmful actions.",
        criteria: {
          allow: "The call is consistent with the user task and its risk is acceptable",
          deny: "The call is destructive, unrelated to the task, or clearly harmful",
        },
      },
      risk: {
        type: "score",
        instructions: "How risky is this tool call if executed?",
        criteria: ["benign", "low", "moderate", "high", "dangerous"],
      },
    };

    /** 评估来源优先级：门控直连 Key → 模型路由（evaluation）→ 环境变量 Key */
    let res: { model?: string; answers?: Record<string, TypesafeAnswer> };
    if (gate.jevApiKey) {
      const client = new TypesafeSystemOneClient(
        gate.jevBaseUrl || "https://api.typesafe.ai",
        gate.jevApiKey,
      );
      res = await client.evaluate(state, questions, gate.jevModel ?? "jev-latest");
    } else if (this.modelRouter) {
      try {
        const routed = await this.modelRouter.evaluate(
          input.tenantId,
          { state, questions },
          gate.routeAlias ? { alias: gate.routeAlias } : {},
        );
        res = { model: routed.model, answers: routed.answers };
      } catch (err) {
        // 没配 evaluation 路由 / 路由失败：回落环境变量直连，两者皆无则降级人工
        const envKey = process.env.TYPESAFE_API_KEY || "";
        if (!envKey) throw err;
        const client = new TypesafeSystemOneClient(
          gate.jevBaseUrl || "https://api.typesafe.ai",
          envKey,
        );
        res = await client.evaluate(state, questions, gate.jevModel ?? "jev-latest");
      }
    } else if (process.env.TYPESAFE_API_KEY) {
      const client = new TypesafeSystemOneClient(
        gate.jevBaseUrl || "https://api.typesafe.ai",
        process.env.TYPESAFE_API_KEY,
      );
      res = await client.evaluate(state, questions, gate.jevModel ?? "jev-latest");
    } else {
      return null;
    }

    const approval = res.answers?.approval;
    if (!approval || approval.type !== "choice") return null;
    const decision = approval.choice === "allow" ? "allow" : "deny";
    const probabilities = approval.probabilities ?? {};
    return {
      model: res.model ?? gate.jevModel ?? "jev-latest",
      decision,
      confidence:
        typeof approval.confidence === "number"
          ? approval.confidence
          : probabilities[approval.choice] ?? 0,
      probabilities,
    };
  }

  private async decideWithLlm(
    input: ToolApprovalGateInput,
    state: Record<string, unknown>,
    llmModel?: string,
  ): Promise<Omit<ToolApprovalAiDecision, "provider" | "latencyMs"> | null> {
    if (!this.modelRouter) return null;
    const messages: ModelChatMessage[] = [
      {
        role: "system",
        content:
          "你是工具调用审批门控。判断 AI Agent 请求的工具调用是否应该被允许执行。" +
          "只输出一个 JSON 对象，不要输出其他内容：\n" +
          '{"decision":"allow|deny","confidence":0到1之间的小数,"rationale":"一句话理由"}\n' +
          "破坏性、越权、与任务无关或有明显危害的调用应拒绝。",
      },
      { role: "user", content: JSON.stringify(state) },
    ];
    const result = await this.modelRouter.chat(
      input.tenantId,
      messages,
      {
        capability: "chat",
        ...(llmModel ? { alias: llmModel } : {}),
      },
      undefined,
    );
    const text = (result.content ?? "").trim();
    const json = extractJson(text);
    if (!json) return null;
    const decision = json.decision === "deny" ? "deny" : "allow";
    const confidence = typeof json.confidence === "number" ? clamp01(json.confidence) : 0.5;
    return {
      model: result.model ?? llmModel ?? "",
      decision,
      confidence,
      rationale: typeof json.rationale === "string" ? json.rationale.slice(0, 300) : undefined,
    };
  }

  private async resolveAnnotations(
    agent: Agent,
    qualifiedName: string,
  ): Promise<McpToolAnnotations | undefined> {
    try {
      const resolver = this.annotationsResolver;
      if (resolver) return (await resolver(agent, qualifiedName)) ?? undefined;
    } catch (err) {
      recordPlatformFault("tool_approval.annotations", err, { subsystem: "tool_approval" });
    }
    const localName = qualifiedName.split(":").pop() ?? qualifiedName;
    return inferToolAnnotations(localName);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 从 LLM 文本中提取第一个 JSON 对象（容忍 ```json 围栏与前后缀） */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter((s): s is string => !!s);
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next
    }
  }
  return null;
}
