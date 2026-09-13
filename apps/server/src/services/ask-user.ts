/**
 * 一等公民「询问用户」：同步阻塞当前工具调用，或异步稍后把答案注入会话。
 * 超时可 skip / 选默认项。密钥不写入 ask_user_resolved 事件。
 */
import { and, eq, lte } from "drizzle-orm";
import type {
  CloudAgentAskUserOption,
  CloudAgentAskUserRequestPayload,
} from "@zakura/shared";
import { recordPlatformFault } from "@zakura/core";
import type { Db } from "../db/client.js";
import { agentUserQuestions, newId } from "../db/schema.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";

export type AskUserMode = "sync" | "async";
export type AskUserTimeoutAction = "skip" | "default";
export type AskUserStatus = "answered" | "skipped" | "timeout" | "cancelled";

export type AskUserAnswer = {
  status: AskUserStatus;
  selected: string[];
  text?: string;
};

const TICK_MS = 5_000;
export const DEFAULT_ROUTINE_ASK_TIMEOUT_SEC = 30 * 60;

type Pending = {
  resolve: (value: AskUserAnswer) => void;
};

function parseOptions(raw: unknown): CloudAgentAskUserOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CloudAgentAskUserOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : id;
    if (!id || !label) continue;
    out.push({
      id,
      label,
      ...(typeof o.description === "string" && o.description.trim()
        ? { description: o.description.trim() }
        : {}),
    });
  }
  return out;
}

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

export type AskUserInput = {
  tenantId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  toolCallId?: string;
  question: string;
  options?: unknown;
  allowMultiple?: boolean;
  secret?: boolean;
  mode?: AskUserMode;
  timeoutSeconds?: number | null;
  timeoutAction?: AskUserTimeoutAction;
  defaultOptionIds?: unknown;
  placeholder?: string;
  /** system 会话（routine）未指定超时则套默认 */
  sessionKind?: string;
};

export class AskUserService {
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private followUp: ((input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    content: string;
  }) => Promise<unknown>) | null = null;

  constructor(
    private readonly db: Db,
    private readonly store: CloudAgentSessionStore,
  ) {}

  setFollowUp(
    fn: (input: {
      tenantId: string;
      agentId: string;
      sessionId: string;
      content: string;
    }) => Promise<unknown>,
  ): void {
    this.followUp = fn;
  }

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

  async ask(input: AskUserInput): Promise<{ text: string; isError?: boolean }> {
    const question = input.question.trim();
    if (!question) return { text: "question is required", isError: true };
    const options = parseOptions(input.options);
    const allowMultiple = input.allowMultiple === true;
    const secret = input.secret === true;
    const mode: AskUserMode = input.mode === "async" ? "async" : "sync";
    const timeoutAction: AskUserTimeoutAction =
      input.timeoutAction === "default" ? "default" : "skip";
    const defaultOptionIds = parseIds(input.defaultOptionIds).filter((id) =>
      options.some((o) => o.id === id),
    );
    if (timeoutAction === "default" && options.length && defaultOptionIds.length === 0) {
      return { text: "timeout_action=default 时需要 default_option_ids", isError: true };
    }

    let timeoutSeconds =
      typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0
        ? Math.floor(input.timeoutSeconds)
        : null;
    if (timeoutSeconds == null && input.sessionKind === "system") {
      timeoutSeconds = DEFAULT_ROUTINE_ASK_TIMEOUT_SEC;
    }

    const id = newId();
    const now = new Date();
    const expiresAt =
      timeoutSeconds != null ? new Date(now.getTime() + timeoutSeconds * 1000) : null;

    await this.db.insert(agentUserQuestions).values({
      id,
      tenantId: input.tenantId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      runId: input.runId,
      toolCallId: input.toolCallId ?? null,
      question,
      optionsJson: JSON.stringify(options),
      allowMultiple,
      secret,
      mode,
      timeoutSeconds,
      timeoutAction,
      defaultOptionIdsJson: JSON.stringify(defaultOptionIds),
      placeholder: (input.placeholder ?? "").trim(),
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const payload: CloudAgentAskUserRequestPayload = {
      requestId: id,
      question,
      options,
      allowMultiple,
      secret,
      mode,
      timeoutSeconds,
      timeoutAction,
      defaultOptionIds,
      placeholder: (input.placeholder ?? "").trim() || undefined,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
    await this.store.appendEvent({
      sessionId: input.sessionId,
      type: "ask_user_request",
      runId: input.runId,
      payload,
    });

    if (mode === "async") {
      return {
        text: JSON.stringify(
          {
            status: "pending",
            question_id: id,
            message: "已向用户发出询问。答案会作为后续消息送达；在此之前继续做不依赖该答案的事。",
            expires_at: expiresAt?.toISOString() ?? null,
          },
          null,
          2,
        ),
      };
    }

    const answer = await this.wait(id, input.runId, expiresAt);
    return { text: this.formatForModel(question, options, answer, secret) };
  }

  async resolve(
    tenantId: string,
    agentId: string,
    sessionId: string,
    input: {
      requestId: string;
      cancelled?: boolean;
      selected?: unknown;
      text?: string;
    },
  ): Promise<void> {
    const row = await this.db.query.agentUserQuestions.findFirst({
      where: and(
        eq(agentUserQuestions.id, input.requestId),
        eq(agentUserQuestions.sessionId, sessionId),
        eq(agentUserQuestions.tenantId, tenantId),
        eq(agentUserQuestions.agentId, agentId),
      ),
    });
    if (!row || row.status !== "pending") throw new Error("没有等待中的询问");

    const options = parseOptions(JSON.parse(row.optionsJson || "[]"));
    const selected = parseIds(input.selected).filter((id) => options.some((o) => o.id === id));
    if (!row.allowMultiple && selected.length > 1) {
      throw new Error("本题只能选一项");
    }
    const answer: AskUserAnswer = input.cancelled
      ? { status: "cancelled", selected: [] }
      : {
          status: "answered",
          selected,
          ...(typeof input.text === "string" && input.text ? { text: input.text } : {}),
        };
    if (
      !input.cancelled &&
      options.length > 0 &&
      selected.length === 0 &&
      !answer.text &&
      !row.secret
    ) {
      throw new Error("请选择一项");
    }
    await this.settle(row.id, answer, { notifyAsync: true });
  }

  async cancelRun(runId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(agentUserQuestions)
      .where(and(eq(agentUserQuestions.runId, runId), eq(agentUserQuestions.status, "pending")));
    for (const row of rows) {
      await this.settle(row.id, { status: "cancelled", selected: [] }, { notifyAsync: false });
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
        .from(agentUserQuestions)
        .where(
          and(eq(agentUserQuestions.status, "pending"), lte(agentUserQuestions.expiresAt, now)),
        )
        .limit(50);
      for (const row of due) {
        await this.expire(row.id);
        n += 1;
      }
    } catch (err) {
      recordPlatformFault("ask_user.tick", err, { subsystem: "ask_user" });
    } finally {
      this.ticking = false;
    }
    return n;
  }

  private wait(id: string, runId: string, expiresAt: Date | null): Promise<AskUserAnswer> {
    return new Promise((resolve) => {
      const finish = (value: AskUserAnswer) => {
        uncancel();
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, { resolve: finish });
      const uncancel = this.store.onRunCancel(runId, () => {
        void this.settle(id, { status: "cancelled", selected: [] }, { notifyAsync: false });
      });
      const ms = expiresAt ? expiresAt.getTime() - Date.now() : 0;
      if (expiresAt && ms <= 0) {
        void this.expire(id);
      }
      const timer =
        expiresAt && ms > 0
          ? setTimeout(() => {
              void this.expire(id);
            }, ms + 20)
          : null;
    });
  }

  private async expire(id: string): Promise<void> {
    const row = await this.db.query.agentUserQuestions.findFirst({
      where: eq(agentUserQuestions.id, id),
    });
    if (!row || row.status !== "pending") return;
    const defaults = parseIds(JSON.parse(row.defaultOptionIdsJson || "[]"));
    const answer: AskUserAnswer =
      row.timeoutAction === "default" && defaults.length
        ? { status: "timeout", selected: defaults }
        : { status: "timeout", selected: [] };
    await this.settle(id, answer, { notifyAsync: true });
  }

  private async settle(
    id: string,
    answer: AskUserAnswer,
    opts: { notifyAsync: boolean },
  ): Promise<void> {
    const row = await this.db.query.agentUserQuestions.findFirst({
      where: eq(agentUserQuestions.id, id),
    });
    if (!row || row.status !== "pending") return;
    const status = answer.status === "timeout" && answer.selected.length ? "answered" : answer.status;
    const stored: AskUserAnswer = {
      status: answer.status,
      selected: answer.selected,
      ...(row.secret ? {} : answer.text ? { text: answer.text } : {}),
    };
    await this.db
      .update(agentUserQuestions)
      .set({
        status,
        answerJson: JSON.stringify(stored),
        resolvedAt: new Date(),
      })
      .where(eq(agentUserQuestions.id, id));

    await this.store.appendEvent({
      sessionId: row.sessionId,
      type: "ask_user_resolved",
      runId: row.runId,
      payload: {
        requestId: id,
        status: answer.status,
        selected: answer.selected,
        hasText: Boolean(answer.text),
      },
    });

    const pending = this.pending.get(id);
    if (pending) {
      pending.resolve(answer);
      this.pending.delete(id);
      return;
    }
    if (opts.notifyAsync && row.mode === "async" && this.followUp) {
      const options = parseOptions(JSON.parse(row.optionsJson || "[]"));
      const content = this.formatFollowUp(row.question, options, answer, row.secret);
      void this.followUp({
        tenantId: row.tenantId,
        agentId: row.agentId,
        sessionId: row.sessionId,
        content,
      }).catch((err: unknown) => {
        recordPlatformFault("ask_user.follow_up", err, { subsystem: "ask_user" });
      });
    }
  }

  private formatForModel(
    question: string,
    options: CloudAgentAskUserOption[],
    answer: AskUserAnswer,
    secret: boolean,
  ): string {
    const labels = answer.selected.map(
      (id) => options.find((o) => o.id === id)?.label ?? id,
    );
    return JSON.stringify(
      {
        status: answer.status,
        question,
        selected: answer.selected,
        selected_labels: labels,
        ...(secret ? (answer.text ? { text: answer.text } : {}) : answer.text ? { text: answer.text } : {}),
        timed_out: answer.status === "timeout",
      },
      null,
      2,
    );
  }

  private formatFollowUp(
    question: string,
    options: CloudAgentAskUserOption[],
    answer: AskUserAnswer,
    secret: boolean,
  ): string {
    const labels = answer.selected.map(
      (id) => options.find((o) => o.id === id)?.label ?? id,
    );
    if (answer.status === "cancelled") {
      return `【询问用户】问题「${question}」已取消。`;
    }
    if (answer.status === "timeout" && labels.length === 0) {
      return `【询问用户】问题「${question}」已超时且未作答（按 skip 处理）。`;
    }
    const bits = [
      `【询问用户】用户已回答「${question}」。`,
      labels.length ? `选择：${labels.join("、")}` : "",
      secret ? "（含密钥，已提交给你，不要复述。）" : answer.text ? `补充：${answer.text}` : "",
      answer.status === "timeout" ? "（超时后采用默认项）" : "",
    ];
    return bits.filter(Boolean).join("\n");
  }
}
