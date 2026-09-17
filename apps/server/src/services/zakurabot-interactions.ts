import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordPlatformFault } from "@zakura/core";
import type { CloudAgentEvent } from "@zakura/shared";
import type { Db } from "../db/client.js";
import { cloudAgentEvents, cloudAgentSessions, zakurabotInteractions, zakurabotMessages, type CloudAgentSession, type ZakurabotInteraction } from "../db/schema.js";
import type { AskUserService } from "./ask-user.js";
import type { AcpSessionService } from "./acp/session.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import type { ZakurabotConversation } from "./zakurabot-store.js";
import { channelIdSchema, zakurabotInteractionSchema, type ZakurabotInteractionPayload } from "./zakurabot-protocol.js";
import { platformEvents } from "./platform-events.js";

const eventTypes = ["ask_user_request", "ask_user_resolved", "permission_request", "permission_resolved",
  "elicitation_request", "elicitation_resolved", "run_end", "run_error"];
const requestKinds = { ask_user_request: "question", permission_request: "approval", elicitation_request: "form" } as const;
type Delivery = (row: ZakurabotInteraction, payload: ZakurabotInteractionPayload) => Promise<void>;
type Watch = {
  conversation: ZakurabotConversation;
  sessionId: string;
  sourceSessionId: string;
  parentRunId?: string;
  deliver: Delivery;
  chain: Promise<void>;
  discovery: Promise<void>;
  unsubscribe: () => void;
  unsubscribeChildren?: () => void;
  lastSyncedSeq: number;
  closed: boolean;
};

export const zakurabotAnswerSchema = z.object({
  cancelled: z.boolean().default(false),
  selected: z.array(channelIdSchema).max(32).optional(),
  optionId: channelIdSchema.optional(),
  text: z.string().max(8000).optional(),
  content: z.record(z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.array(z.string().max(2000)).max(32)])).optional(),
}).strict();

export class ZakurabotInteractionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Explicit allowlist: raw tool arguments/results, reasoning, and answer text are never projected. */
function requestPayload(event: CloudAgentEvent): ZakurabotInteractionPayload | null {
  const type = requestKinds[event.type as keyof typeof requestKinds];
  if (!type) return null;
  const source = record(event.payload);
  const options = Array.isArray(source.options) ? source.options.map((option) => {
    const item = record(option);
    return type === "approval" ? { id: item.optionId, label: item.name, kind: item.kind } :
      { id: item.id, label: item.label, description: item.description };
  }) : undefined;
  const parsed = zakurabotInteractionSchema.safeParse({
    type, requestId: source.requestId, status: "pending",
    title: type === "question" ? source.question : source.title ?? source.message ?? "需要授权",
    options,
    ...(type === "question" ? { allowMultiple: source.allowMultiple, secret: source.secret,
      mode: source.mode, expiresAt: source.expiresAt, placeholder: source.placeholder } : {}),
    ...(type === "form" ? { mode: source.mode, url: source.url, fields: source.fields } : {}),
  });
  if (!parsed.success) {
    recordPlatformFault("zakurabot.interaction_payload", new Error("Invalid interaction metadata"), { subsystem: "remote_agent" });
    return null;
  }
  return parsed.data;
}

export class ZakurabotInteractionService {
  private readonly watches = new Map<string, Watch>();
  private closed = false;
  constructor(private readonly db: Db, private readonly deps: {
    sessions: CloudAgentSessionStore;
    askUser?: Pick<AskUserService, "resolve" | "cancelRun">;
    acp?: Pick<AcpSessionService, "resolvePermission" | "resolveElicitation">;
  }) {}

  private where(c: ZakurabotConversation) {
    return and(eq(zakurabotInteractions.tenantId, c.tenantId), eq(zakurabotInteractions.deviceId, c.deviceId),
      eq(zakurabotInteractions.bindingId, c.bindingId), eq(zakurabotInteractions.agentId, c.agentId));
  }

  payload(row: ZakurabotInteraction) {
    return zakurabotInteractionSchema.parse({ ...JSON.parse(row.payloadJson),
      status: row.status === "resolving" ? "pending" : row.status });
  }

  private view(row: ZakurabotInteraction) {
    return { messageId: row.id, createdAt: row.createdAt.getTime(), interaction: this.payload(row),
      ...(row.replyTo ? { replyTo: row.replyTo } : {}) };
  }

  async snapshot(c: ZakurabotConversation, messageId: string, sessionId?: string) {
    const [row] = await this.db.select().from(zakurabotInteractions)
      .where(and(this.where(c), eq(zakurabotInteractions.id, messageId),
        sessionId ? eq(zakurabotInteractions.sessionId, sessionId) : undefined)).limit(1);
    if (!row) throw new ZakurabotInteractionError("Interaction not found in this conversation", 404);
    return this.view(row);
  }

  async pending(c: ZakurabotConversation, sessionId: string) {
    return this.db.select().from(zakurabotInteractions).where(and(this.where(c),
      eq(zakurabotInteractions.sessionId, sessionId), inArray(zakurabotInteractions.status, ["pending", "resolving"])))
      .orderBy(asc(zakurabotInteractions.createdAt)).limit(100);
  }

  async hasDeliveredReply(c: ZakurabotConversation, sessionId: string, runId: string) {
    const rows = await this.db.select({ id: zakurabotInteractions.id }).from(zakurabotInteractions)
      .innerJoin(zakurabotMessages, eq(zakurabotMessages.id, zakurabotInteractions.id))
      .where(and(this.where(c), eq(zakurabotInteractions.sessionId, sessionId), eq(zakurabotInteractions.runId, runId))).limit(1);
    return rows.length > 0;
  }

  async watch(c: ZakurabotConversation, sessionId: string, deliver: Delivery) {
    if (this.closed) throw new ZakurabotInteractionError("Interactions are unavailable", 503);
    const existing = this.watches.get(sessionId);
    if (existing) {
      if (existing.sessionId !== sessionId || Object.entries(c).some(([key, value]) =>
        existing.conversation[key as keyof ZakurabotConversation] !== value)) {
        throw new ZakurabotInteractionError("Interaction session does not belong to this conversation", 404);
      }
      existing.deliver = deliver;
      await this.sync(sessionId);
      return;
    }
    const watch = this.attach(c, sessionId, sessionId, deliver);
    // ACP work runs in its own session. Discover it before/replay after its first permission event.
    watch.unsubscribeChildren = platformEvents.subscribe(c.tenantId, (event) => {
      if (watch.closed || event.type !== "cloud_session_changed" || event.reason !== "created" || event.agentId !== c.agentId) return;
      watch.discovery = watch.discovery.then(async () => {
        const child = await this.deps.sessions.getSession(c.tenantId, c.agentId, event.sessionId);
        if (child) await this.attachChild(watch, child);
      }).catch((error) => recordPlatformFault("zakurabot.interaction_child", error, { subsystem: "remote_agent" }));
    });
    await this.sync(sessionId);
  }

  private attach(c: ZakurabotConversation, sessionId: string, sourceSessionId: string, deliver: Delivery, parentRunId?: string) {
    const watch: Watch = { conversation: c, sessionId, sourceSessionId, parentRunId, deliver,
      chain: Promise.resolve(), discovery: Promise.resolve(), unsubscribe: () => {}, lastSyncedSeq: 0, closed: false };
    this.watches.set(sourceSessionId, watch);
    watch.unsubscribe = this.deps.sessions.subscribe(sourceSessionId, (event) => {
      if (watch.closed) return;
      if (!eventTypes.includes(event.type)) return;
      watch.chain = watch.chain.then(() => this.project(watch, event)).catch((error) => {
        recordPlatformFault("zakurabot.interaction", error, { subsystem: "remote_agent" });
      });
    });
    return watch;
  }

  private async attachChild(parent: Watch, child: CloudAgentSession) {
    if (parent.closed || this.closed || this.watches.has(child.id) || child.kind !== "acp") return;
    const origin = record(JSON.parse(child.originJson));
    if (origin.source !== "agent_loop" || origin.parentSessionId !== parent.sessionId ||
      !channelIdSchema.safeParse(origin.parentRunId).success) return;
    const parentRun = await this.deps.sessions.getRun(origin.parentRunId as string);
    if (parentRun?.sessionId !== parent.sessionId || parent.closed || this.closed || this.watches.has(child.id)) return;
    const watch = this.attach(parent.conversation, parent.sessionId, child.id,
      (row, payload) => parent.deliver(row, payload), parentRun.id);
    await this.syncSource(watch);
  }

  async sync(sessionId: string) {
    const watch = this.watches.get(sessionId);
    if (!watch || watch.closed) return;
    if (watch.sessionId === watch.sourceSessionId) {
      await watch.discovery;
      const children = await this.db.select().from(cloudAgentSessions).where(and(
        eq(cloudAgentSessions.tenantId, watch.conversation.tenantId), eq(cloudAgentSessions.agentId, watch.conversation.agentId),
        eq(cloudAgentSessions.kind, "acp"), sql`${cloudAgentSessions.originJson}::jsonb ->> 'parentSessionId' = ${sessionId}`,
      ));
      for (const child of children) await this.attachChild(watch, child);
    }
    await this.syncSource(watch);
    for (const child of this.watches.values()) {
      if (child !== watch && child.sessionId === sessionId) await this.syncSource(child);
    }
  }

  private async syncSource(watch: Watch) {
    if (watch.closed) return;
    const sessionId = watch.sourceSessionId;
    const work = async () => {
      let after = watch.lastSyncedSeq;
      for (;;) {
        const rows = await this.db.select().from(cloudAgentEvents).where(and(
          eq(cloudAgentEvents.sessionId, sessionId), inArray(cloudAgentEvents.type, eventTypes), gt(cloudAgentEvents.seq, after),
        )).orderBy(asc(cloudAgentEvents.seq)).limit(200);
        for (const row of rows) {
          await this.project(watch, { id: row.id, sessionId, runId: row.runId, seq: row.seq,
            type: row.type as CloudAgentEvent["type"], payload: JSON.parse(row.payloadJson), createdAt: row.createdAt.toISOString() });
          after = row.seq;
          watch.lastSyncedSeq = row.seq;
        }
        if (rows.length < 200) break;
      }
    };
    const pending = watch.chain.then(work);
    watch.chain = pending.catch(() => undefined);
    await pending;
  }

  private async project(watch: Watch, event: CloudAgentEvent) {
    const c = watch.conversation;
    if (event.type === "run_end" || event.type === "run_error") {
      if (!event.runId) return;
      const pending = await this.db.select().from(zakurabotInteractions).where(and(this.where(c),
        eq(zakurabotInteractions.sessionId, watch.sessionId), watch.parentRunId
          ? and(eq(zakurabotInteractions.sourceSessionId, event.sessionId), eq(zakurabotInteractions.sourceRunId, event.runId))
          : eq(zakurabotInteractions.runId, event.runId)));
      for (const row of pending) {
        const payload = this.payload(row);
        if (payload.type === "question" && payload.mode === "async" && row.sourceSessionId === row.sessionId) continue;
        const [cancelled] = await this.db.update(zakurabotInteractions).set({ status: "cancelled",
          ...(row.sourceSessionId === event.sessionId ? { eventSeq: event.seq } : {}) })
          .where(and(eq(zakurabotInteractions.id, row.id), inArray(zakurabotInteractions.status, ["pending", "resolving"]),
            // Parent and ACP child sequence numbers are independent.
            row.sourceSessionId === event.sessionId ? lt(zakurabotInteractions.eventSeq, event.seq) : undefined)).returning();
        await this.ensureDelivered(watch, cancelled ?? row);
      }
      return;
    }
    const request = requestPayload(event);
    if (request) {
      const sourceRun = event.runId ? await this.deps.sessions.getRun(event.runId) : null;
      if (event.runId && sourceRun?.sessionId !== event.sessionId) return;
      const parentRun = watch.parentRunId ? await this.deps.sessions.getRun(watch.parentRunId) : null;
      const ended = (run: typeof sourceRun) => run && run.status !== "queued" && run.status !== "running";
      const cancelled = ended(parentRun) || (ended(sourceRun) && !(request.type === "question" && request.mode === "async"));
      const id = `zbi_${createHash("sha256").update(JSON.stringify([c.tenantId, c.deviceId, c.bindingId, c.agentId, event.id])).digest("hex")}`;
      const [echo] = await this.db.select({ clientMessageId: zakurabotMessages.clientMessageId }).from(zakurabotMessages)
        .where(and(eq(zakurabotMessages.tenantId, c.tenantId), eq(zakurabotMessages.deviceId, c.deviceId),
          eq(zakurabotMessages.bindingId, c.bindingId), eq(zakurabotMessages.agentId, c.agentId),
          isNotNull(zakurabotMessages.clientMessageId), lte(zakurabotMessages.createdAt, (parentRun ?? sourceRun)?.createdAt ?? new Date(event.createdAt))))
        .orderBy(desc(zakurabotMessages.seq)).limit(1);
      const [inserted] = await this.db.insert(zakurabotInteractions).values({ id, ...c, sessionId: watch.sessionId,
        runId: watch.parentRunId ?? event.runId, sourceSessionId: event.sessionId, sourceRunId: event.runId,
        requestId: request.requestId, type: request.type, payloadJson: JSON.stringify(request), status: cancelled ? "cancelled" : "pending",
        replyTo: echo?.clientMessageId, eventSeq: event.seq, createdAt: new Date(event.createdAt),
      }).onConflictDoNothing().returning();
      const row = inserted ?? (await this.db.select().from(zakurabotInteractions).where(eq(zakurabotInteractions.id, id)).limit(1))[0];
      if (row) await this.ensureDelivered(watch, row);
      return;
    }
    if (!["ask_user_resolved", "permission_resolved", "elicitation_resolved"].includes(event.type)) return;
    const source = record(event.payload);
    if (!channelIdSchema.safeParse(source.requestId).success) return;
    const type = event.type === "ask_user_resolved" ? "question" : event.type === "permission_resolved" ? "approval" : "form";
    const status = type === "question" ? source.status : type === "approval" ?
      source.outcome === "selected" ? "answered" : "cancelled" : source.cancelled ? "cancelled" : "resolved";
    if (!zakurabotInteractionSchema.shape.status.safeParse(status).success || status === "pending") return;
    const where = and(this.where(c), eq(zakurabotInteractions.sourceSessionId, event.sessionId),
        eq(zakurabotInteractions.requestId, source.requestId as string), eq(zakurabotInteractions.type, type),
        event.runId ? or(eq(zakurabotInteractions.sourceRunId, event.runId),
          type === "form" ? isNull(zakurabotInteractions.sourceRunId) : undefined) : isNull(zakurabotInteractions.sourceRunId));
    await this.db.update(zakurabotInteractions).set({ status: status as string, eventSeq: event.seq })
      .where(and(where, lt(zakurabotInteractions.eventSeq, event.seq)));
    const rows = await this.db.select().from(zakurabotInteractions).where(where);
    for (const row of rows) await this.ensureDelivered(watch, row);
  }

  private async ensureDelivered(watch: Watch, row: ZakurabotInteraction) {
    const [message] = await this.db.select({ frameJson: zakurabotMessages.frameJson }).from(zakurabotMessages)
      .where(eq(zakurabotMessages.id, row.id)).limit(1);
    const payload = this.payload(row);
    const existing = message ? JSON.parse(message.frameJson) : null;
    if (existing?.payload?.interaction?.status !== payload.status) await watch.deliver(row, payload);
  }

  async respond(c: ZakurabotConversation, sessionId: string, messageId: string, input: z.infer<typeof zakurabotAnswerSchema>,
    authorize: () => Promise<void>) {
    await this.sync(sessionId);
    const [row] = await this.db.select().from(zakurabotInteractions).where(and(this.where(c),
      eq(zakurabotInteractions.sessionId, sessionId), eq(zakurabotInteractions.id, messageId))).limit(1);
    if (!row) throw new ZakurabotInteractionError("Interaction not found in this conversation", 404);
    const leaseExpired = row.status === "resolving" && row.claimedAt && row.claimedAt.getTime() < Date.now() - 300_000;
    if (row.status !== "pending" && !leaseExpired) throw new ZakurabotInteractionError("Interaction is no longer pending", 409);
    const payload = this.payload(row);
    if (payload.expiresAt && new Date(payload.expiresAt).getTime() <= Date.now()) {
      throw new ZakurabotInteractionError("Interaction has expired", 409);
    }
    const requireActiveRun = async () => {
      const session = await this.deps.sessions.getSession(c.tenantId, c.agentId, sessionId);
      if (!session || ((payload.type !== "question" || payload.mode !== "async") &&
        (row.runId ? session.activeRunId !== row.runId : payload.type !== "form"))) {
        throw new ZakurabotInteractionError("Interaction run has ended", 409);
      }
      if (row.sourceSessionId !== sessionId) {
        const source = await this.deps.sessions.getSession(c.tenantId, c.agentId, row.sourceSessionId);
        const origin = source ? record(JSON.parse(source.originJson)) : {};
        if (!source || source.kind !== "acp" || origin.source !== "agent_loop" || origin.parentSessionId !== sessionId ||
          origin.parentRunId !== row.runId || (row.sourceRunId && source.activeRunId !== row.sourceRunId)) {
          throw new ZakurabotInteractionError("Interaction source has ended or changed", 409);
        }
      }
    };
    await requireActiveRun();
    const ids = new Set(payload.options?.map((option) => option.id) ?? []);
    if (!input.cancelled) {
      if (payload.type === "approval" && (!input.optionId || !ids.has(input.optionId))) {
        throw new ZakurabotInteractionError("Choose one of the offered approval options", 400);
      }
      if (payload.type === "question") {
        const selected = input.selected ?? [];
        if (selected.some((id) => !ids.has(id)) || new Set(selected).size !== selected.length ||
          (!payload.allowMultiple && selected.length > 1) || (!selected.length && !input.text?.trim())) {
          throw new ZakurabotInteractionError("Provide an answer using the offered options or text", 400);
        }
      }
      if (payload.type === "form") {
        const fields = payload.fields ?? [];
        if (Object.keys(input.content ?? {}).some((key) => !fields.some((field) => field.id === key)) ||
          fields.some((field) => field.required && input.content?.[field.id] === undefined)) {
          throw new ZakurabotInteractionError("Form fields do not match the request", 400);
        }
        for (const field of fields) {
          const value = input.content?.[field.id];
          if (value === undefined) continue;
          const valid = field.type === "integer" ? Number.isInteger(value) : field.type === "array" ? Array.isArray(value) :
            ["string", "number", "boolean"].includes(field.type) && typeof value === field.type;
          if (!valid) throw new ZakurabotInteractionError("Form field has the wrong type", 400);
          if (field.options?.length && (typeof value !== "string" || !field.options.includes(value))) {
            throw new ZakurabotInteractionError("Choose one of the offered form values", 400);
          }
        }
      }
    }
    const [claimed] = await this.db.update(zakurabotInteractions).set({ status: "resolving", claimedAt: new Date() })
      .where(and(eq(zakurabotInteractions.id, row.id), or(eq(zakurabotInteractions.status, "pending"),
        and(eq(zakurabotInteractions.status, "resolving"), lt(zakurabotInteractions.claimedAt, new Date(Date.now() - 300_000)))))).returning();
    if (!claimed) throw new ZakurabotInteractionError("Interaction is already being answered", 409);
    const claimWhere = and(eq(zakurabotInteractions.id, row.id), eq(zakurabotInteractions.status, "resolving"),
      eq(zakurabotInteractions.claimedAt, claimed.claimedAt!));
    try {
      await authorize();
      await requireActiveRun();
      const [current] = await this.db.select({ id: zakurabotInteractions.id }).from(zakurabotInteractions).where(claimWhere).limit(1);
      if (!current) throw new ZakurabotInteractionError("Interaction is no longer pending", 409);
    } catch (error) {
      await this.db.update(zakurabotInteractions).set({ status: "pending", claimedAt: null })
        .where(claimWhere);
      throw error;
    }
    try {
      if (payload.type === "question") {
        if (!this.deps.askUser) throw new ZakurabotInteractionError("Questions are unavailable", 503);
        await this.deps.askUser.resolve(c.tenantId, c.agentId, row.sourceSessionId, { requestId: row.requestId,
          cancelled: input.cancelled, selected: input.selected, text: input.text });
      } else if (payload.type === "approval") {
        if (!this.deps.acp) throw new ZakurabotInteractionError("Approvals are unavailable", 503);
        await this.deps.acp.resolvePermission(c.tenantId, c.agentId, row.sourceSessionId, { requestId: row.requestId,
          cancelled: input.cancelled, optionId: input.optionId });
      } else {
        if (!this.deps.acp) throw new ZakurabotInteractionError("Forms are unavailable", 503);
        await this.deps.acp.resolveElicitation(c.tenantId, c.agentId, row.sourceSessionId, { requestId: row.requestId,
          cancelled: input.cancelled, content: input.content });
      }
    } catch (error) {
      await this.db.update(zakurabotInteractions).set({ status: "pending", claimedAt: null })
        .where(claimWhere);
      if (error instanceof ZakurabotInteractionError) throw error;
      throw new ZakurabotInteractionError("Interaction could not be answered; it may have ended", 409);
    }
    const [resolved] = await this.db.update(zakurabotInteractions).set({
      status: input.cancelled ? "cancelled" : payload.type === "form" ? "resolved" : "answered", claimedAt: null,
    }).where(claimWhere).returning();
    const watch = this.watches.get(sessionId);
    if (resolved && watch) await this.ensureDelivered(watch, resolved);
    await this.sync(sessionId);
    return this.snapshot(c, messageId);
  }

  async cancelSession(c: ZakurabotConversation, sessionId: string) {
    await this.sync(sessionId);
    const rows = await this.db.update(zakurabotInteractions).set({ status: "cancelled", claimedAt: null })
      .where(and(this.where(c), eq(zakurabotInteractions.sessionId, sessionId),
        inArray(zakurabotInteractions.status, ["pending", "resolving"]))).returning();
    // Also retire asynchronous questions in the owning service, so a later timeout cannot revive old context.
    for (const runId of new Set(rows.filter((row) => row.type === "question").map((row) => row.sourceRunId))) {
      if (runId) await this.deps.askUser?.cancelRun(runId);
    }
    const watch = this.watches.get(sessionId);
    if (watch) for (const row of rows) await this.ensureDelivered(watch, row);
  }

  async close() {
    this.closed = true;
    for (const watch of this.watches.values()) {
      watch.closed = true;
      watch.unsubscribe();
      watch.unsubscribeChildren?.();
    }
    await Promise.all(Array.from(this.watches.values(), (watch) => Promise.all([watch.chain, watch.discovery])));
    this.watches.clear();
  }

  async unwatch(sessionId: string) {
    const watches = Array.from(this.watches.values()).filter((watch) => watch.sessionId === sessionId);
    for (const watch of watches) {
      watch.closed = true;
      watch.unsubscribe();
      watch.unsubscribeChildren?.();
    }
    await Promise.all(watches.map((watch) => Promise.all([watch.chain, watch.discovery])));
    for (const watch of watches) this.watches.delete(watch.sourceSessionId);
  }
}
