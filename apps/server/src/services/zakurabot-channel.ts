import { createHash } from "node:crypto";
import { recordPlatformFault } from "@zakura/core";
import type { CloudAgentEvent } from "@zakura/shared";
import type { AgentChannelBinding, ZakurabotDevice } from "../db/schema.js";
import type { AgentService } from "./agents.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import { isRemoteSenderAllowed, type RemoteAgentIngress } from "./remote-agent-ingress.js";
import { formatRemoteInboundPrefix, type RemoteChannelSessionHandle, type RemoteChannelToolPort } from "./remote-channel-tools.js";
import { waitForRemoteRun } from "./remote-channel-stream.js";
import { createZakurabotChat } from "./zakurabot-adapter.js";
import type { ZakurabotAgent, ZakurabotClientFrame, ZakurabotServerFrame, ZakurabotToolFrame, ZakurabotUserFrame } from "./zakurabot-protocol.js";
import { deviceBindingIds, type ZakurabotConversation, type ZakurabotStore } from "./zakurabot-store.js";
import { ZakurabotFileError, type ZakurabotFileService } from "./zakurabot-files.js";
import { isSessionAdmin } from "./auth.js";

export class ZakurabotAccessError extends Error {
  constructor(message: string, readonly closeCode: 4401 | 4403) { super(message); }
}

export class ZakurabotInputError extends Error {}

export type ZakurabotIdentity = Pick<ZakurabotDevice, "id" | "tenantId">;
type Subscriber = (conversation: ZakurabotConversation, frame: ZakurabotServerFrame) => Promise<void>;
type ActiveRun = { sessionId: string; runId: string; handle: RemoteChannelSessionHandle;
  conversation: ZakurabotConversation; abort: AbortController; done: Promise<void> };

export function zakurabotThreadId(c: ZakurabotConversation): string {
  return `zakurabot:${c.deviceId}:${c.bindingId}:${c.agentId}`;
}

/** Reuses the remote ingress, session registry, tools, and silent-run fallback. */
export class ZakurabotChannel {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly handles = new Map<string, RemoteChannelSessionHandle>();
  private stopped = false;

  constructor(readonly deps: {
    store: ZakurabotStore;
    ingress: RemoteAgentIngress;
    sessions: RemoteChannelToolPort;
    sessionStore: CloudAgentSessionStore;
    agents: Pick<AgentService, "get">;
    files?: ZakurabotFileService;
    publishFile: (conversation: ZakurabotConversation, path: string) => Promise<{ url: string; name: string }>;
  }) {}

  capabilities(): string[] {
    return ["agents", "history", ...(this.deps.files ? ["files"] : [])];
  }

  async authorizableBindings(tenantId: string, userId: string) {
    const user = await this.deps.store.getActiveUser(tenantId, userId);
    if (!user) throw new ZakurabotAccessError("An active tenant membership is required", 4403);
    const bindings = (await this.deps.ingress.listBindings(tenantId, "zakurabot")).filter((binding) => {
      const settings = this.deps.ingress.toBindingView(binding)!.settings;
      return binding.enabled && settings.allowDMs !== false &&
        (isSessionAdmin(user) || isRemoteSenderAllowed(settings, user.userId, user.email));
    });
    return { user, bindings };
  }

  async issueDevice(tenantId: string, input: { name: string; bindingIds: string[]; expiresInDays: number; userId?: string }) {
    if (input.userId) {
      const allowed = new Set((await this.authorizableBindings(tenantId, input.userId)).bindings.map((binding) => binding.id));
      if (input.bindingIds.some((id) => !allowed.has(id))) throw new ZakurabotAccessError("You cannot authorize these bindings", 4403);
    }
    const agents = new Set<string>();
    for (const id of input.bindingIds) {
      const binding = await this.deps.ingress.getBinding(tenantId, id);
      if (!binding || binding.platform !== "zakurabot" || !binding.enabled) {
        throw new Error("设备只能授权本租户已启用的 Zakura Bot 绑定");
      }
      if (agents.has(binding.agentId)) throw new Error("同一设备每个 Agent 只能选择一个绑定");
      agents.add(binding.agentId);
    }
    const issued = await this.deps.store.createDevice(tenantId, input);
    try {
      // Browser consent delegates the user's allowed bindings. An open ACL must remain open:
      // adding its first allowedUsers entry would turn it into a restrictive allowlist.
      for (const id of input.bindingIds) {
        const binding = await this.deps.ingress.getBinding(tenantId, id);
        const settings = this.deps.ingress.toBindingView(binding)!.settings;
        if (!isRemoteSenderAllowed(settings, issued.device.id)) {
          await this.deps.ingress.approveUser(tenantId, id, issued.device.id);
        }
      }
      return issued;
    } catch (error) {
      await this.deps.store.revokeDevice(tenantId, issued.device.id);
      throw error;
    }
  }

  async authorizedBindings(identity: ZakurabotIdentity) {
    if (this.stopped) throw new Error("Zakura Bot is stopping");
    const device = await this.deps.store.getActiveDevice(identity.tenantId, identity.id);
    if (!device) throw new ZakurabotAccessError("Device token is invalid, expired, or revoked", 4401);
    const owner = device.userId ? await this.deps.store.getActiveUser(device.tenantId, device.userId) : null;
    if (device.userId && !owner) throw new ZakurabotAccessError("The device owner is no longer an active member", 4401);
    const grants = new Set(deviceBindingIds(device));
    const bindings = (await this.deps.ingress.listBindings(device.tenantId, "zakurabot"))
      .filter((binding) => {
        if (!grants.has(binding.id) || !binding.enabled) return false;
        const settings = this.deps.ingress.toBindingView(binding)!.settings;
        return settings.allowDMs !== false && isRemoteSenderAllowed(settings, device.id) &&
          (!owner || isSessionAdmin(owner) || isRemoteSenderAllowed(settings, owner.userId, owner.email));
      });
    return { device, bindings };
  }

  private async authorize(c: ZakurabotConversation) {
    const { device, bindings } = await this.authorizedBindings({ id: c.deviceId, tenantId: c.tenantId });
    const binding = bindings.find((b) => b.id === c.bindingId && b.agentId === c.agentId);
    if (!binding) throw new ZakurabotAccessError("This device cannot access the requested agent", 4403);
    return { device, binding };
  }

  private conversation(device: ZakurabotIdentity, binding: AgentChannelBinding): ZakurabotConversation {
    return { tenantId: device.tenantId, deviceId: device.id, bindingId: binding.id, agentId: binding.agentId };
  }

  async roster(identity: ZakurabotIdentity) {
    const { device, bindings } = await this.authorizedBindings(identity);
    const agents: ZakurabotAgent[] = [];
    const conversations: ZakurabotConversation[] = [];
    for (const binding of bindings) {
      // A binding may have been reassigned since issuance. Fail closed on ambiguous routing.
      if (bindings.filter((b) => b.agentId === binding.agentId).length !== 1) continue;
      const agent = await this.deps.agents.get(device.tenantId, binding.agentId);
      if (!agent) continue;
      const c = this.conversation(device, binding);
      const status = await this.deps.ingress.getThreadStatus(device.tenantId, binding.id, zakurabotThreadId(c));
      agents.push({ id: agent.id, name: agent.name || binding.label || "Agent", title: binding.label, description: agent.description,
        status: status?.activeRunId ? "busy" : "idle", color: "#1084fe", unread: false, bindingId: binding.id,
        capabilities: { files: Boolean(agent.enableFs && this.deps.files), desktop: false, interactions: false } });
      conversations.push(c);
    }
    if (!agents.length) throw new ZakurabotAccessError("No enabled Zakura Bot bindings are authorized for this device", 4403);
    return { agents, conversations };
  }

  subscribe(identity: ZakurabotIdentity, subscriber: Subscriber): () => void {
    const key = `${identity.tenantId}:${identity.id}`;
    const listeners = this.subscribers.get(key) ?? new Set<Subscriber>();
    listeners.add(subscriber);
    this.subscribers.set(key, listeners);
    return () => { listeners.delete(subscriber); if (!listeners.size) this.subscribers.delete(key); };
  }

  async history(c: ZakurabotConversation, limit?: number) {
    await this.authorize(c);
    return this.deps.store.history(c, limit);
  }

  private async publish(c: ZakurabotConversation, frame: ZakurabotServerFrame, shouldPublish?: () => boolean): Promise<void> {
    await this.authorize(c);
    if (shouldPublish && !shouldPublish()) return;
    if (frame.type === "chat_reply" || frame.type === "message") {
      frame = await this.deps.store.appendMessage(c, frame);
    }
    // Persistence is the delivery boundary. A disconnected socket can replay the message later.
    const listeners = this.subscribers.get(`${c.tenantId}:${c.deviceId}`) ?? [];
    // Slow sockets must not block an agent after its reply has been durably stored.
    void Promise.allSettled(Array.from(listeners, (listener) => Promise.resolve().then(() => listener(c, frame))));
  }

  async resolveConversation(identity: ZakurabotIdentity, agentId: string) {
    const { device, bindings } = await this.authorizedBindings(identity);
    const matches = bindings.filter((b) => b.agentId === agentId);
    if (matches.length !== 1) throw new ZakurabotAccessError("This device cannot access the requested agent", 4403);
    return { device, conversation: this.conversation(device, matches[0]!) };
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.chains.set(key, current);
    return current.finally(() => { if (this.chains.get(key) === current) this.chains.delete(key); });
  }

  async send(identity: ZakurabotIdentity, frame: Extract<ZakurabotClientFrame, { type: "send" }>) {
    const { device, conversation: c } = await this.resolveConversation(identity, frame.agentId);
    const threadId = zakurabotThreadId(c);
    await this.serial(threadId, async () => {
      await this.authorize(c);
      const existing = await this.deps.store.userMessage(c, frame.clientMessageId);
      const fileIds = frame.attachments?.map((file) => file.fileId) ?? [];
      if (fileIds.length && !this.deps.files) throw new ZakurabotInputError("File uploads are unavailable");
      let files: Awaited<ReturnType<ZakurabotFileService["resolveAttachments"]>> | undefined;
      // A retry must still succeed if an accepted upload was subsequently moved or removed by the agent.
      if (!existing && fileIds.length) {
        try { files = await this.deps.files!.resolveAttachments(c, fileIds); }
        catch (error) {
          if (error instanceof ZakurabotFileError) throw new ZakurabotInputError(error.message);
          throw error;
        }
      }
      const attachmentViews = existing?.message.attachments ?? files?.views;
      const text = frame.text || `📎 ${attachmentViews?.map((file) => file.name).join(", ") ?? "Files"}`;
      if (existing && (existing.message.text !== text ||
        JSON.stringify(existing.message.attachments?.map((file) => file.id) ?? []) !== JSON.stringify(fileIds))) {
        throw new ZakurabotInputError("This message was already sent with different text or files; send it as a new message");
      }
      const echo: ZakurabotUserFrame = existing ?? { type: "message", message: {
        id: frame.clientMessageId, agentId: c.agentId, role: "user", kind: "text", text,
        clientMessageId: frame.clientMessageId, createdAt: Date.now(),
        ...(files?.views.length ? { attachments: files.views } : {}),
      } };
      let boundSessionId: string | undefined;
      const requireCurrentTurn = () => {
        if (!boundSessionId || this.deps.sessions.get(boundSessionId) !== handle) {
          throw new Error("This remote turn has been superseded");
        }
      };
      const chat = createZakurabotChat({
        agentId: c.agentId, deviceId: device.id, deviceName: device.name, threadId,
        post: (message) => this.publish(c, message, () => {
          requireCurrentTurn();
          return message.type !== "typing" || !message.active || this.runs.get(threadId)?.handle === handle;
        }),
        history: (limit) => { requireCurrentTurn(); return this.history(c, limit); },
        publishFile: async (path) => { requireCurrentTurn(); await this.authorize(c); return this.deps.publishFile(c, path); },
      });
      const handle: RemoteChannelSessionHandle = {
        chat, threadId, channelId: threadId, platform: "zakurabot", bindingId: c.bindingId,
        inboundMessageId: frame.clientMessageId, isDM: true, isThread: false, trigger: "dm",
        sender: { userId: device.id, userName: device.name, fullName: device.name },
        chatReplySuccessCount: 0, autoFallbackPosted: false,
      };
      const result = await this.deps.ingress.handleInbound({
        tenantId: c.tenantId, bindingId: c.bindingId, platform: "zakurabot",
        externalEventId: `${threadId}:${frame.clientMessageId}`, externalThreadKey: threadId,
        externalUserKey: device.id, text: `${formatRemoteInboundPrefix(handle)}\n${text}`,
        attachments: files?.attachments,
        title: `Zakura Bot · ${device.name}`,
        onSessionReady: async (sessionId) => {
          const previous = this.runs.get(threadId);
          previous?.abort.abort();
          await previous?.done;
          await this.authorize(c);
          await this.publish(c, echo);
          this.deps.sessions.bind(sessionId, handle);
          boundSessionId = sessionId;
          this.handles.set(sessionId, handle);
        },
      });
      if (!result.accepted) throw new ZakurabotAccessError("Message rejected by the remote channel binding", 4403);
      if (result.duplicate) { await this.publish(c, echo); return; }
      const run: ActiveRun = { sessionId: result.sessionId, runId: result.runId, handle, conversation: c,
        abort: new AbortController(), done: Promise.resolve() };
      this.runs.set(threadId, run);
      run.done = this.observeRun(run).catch((error) => {
        recordPlatformFault("zakurabot.run", error, { subsystem: "remote_agent" });
      });
    });
  }

  async interrupt(identity: ZakurabotIdentity, agentId: string) {
    const { conversation: c } = await this.resolveConversation(identity, agentId);
    const threadId = zakurabotThreadId(c);
    await this.serial(threadId, async () => {
      await this.authorize(c);
      await this.deps.ingress.stopThreadRun(c.tenantId, c.bindingId, threadId);
    });
  }

  /** Session operations share the same queue as sends, so a reset cannot race a new turn. */
  async manageSession(identity: ZakurabotIdentity, agentId: string, action: "status" | "start" | "stop" | "new") {
    const { device, conversation: c } = await this.resolveConversation(identity, agentId);
    const threadId = zakurabotThreadId(c);
    return this.serial(threadId, async () => {
      await this.authorize(c);
      const current = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, threadId);
      if (action === "stop") await this.deps.ingress.stopThreadRun(c.tenantId, c.bindingId, threadId);
      if (action === "new" || (action === "start" && !current)) {
        await this.deps.ingress.resetThreadSession(c.tenantId, c.bindingId, threadId, device.id, `Zakura Bot · ${device.name}`);
        const previous = this.runs.get(threadId);
        previous?.abort.abort();
        await previous?.done;
        if (current && this.deps.sessions.get(current.sessionId) === this.handles.get(current.sessionId)) {
          this.deps.sessions.unbind(current.sessionId);
          this.handles.delete(current.sessionId);
        }
      }
      const status = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, threadId);
      return { bindingId: c.bindingId, agentId: c.agentId, sessionId: status?.sessionId ?? null,
        status: status?.activeRunId ? "busy" : status ? "ready" : "not_started", title: status?.title ?? null };
    });
  }

  private async observeRun(run: ActiveRun) {
    const c = run.conversation;
    const threadId = zakurabotThreadId(c);
    const tools = new Map<string, { seq: number; frame: ZakurabotToolFrame }>();
    let activity = Promise.resolve();
    const onEvent = (event: CloudAgentEvent) => {
      if (run.abort.signal.aborted || event.runId !== run.runId) return;
      if (event.type !== "tool_call_start" && event.type !== "tool_call_result") return;
      const payload = event.payload as { toolCallId: string; name: string; isError?: boolean };
      if (!payload.toolCallId || !payload.name) return;
      const previous = tools.get(payload.toolCallId);
      if (previous && previous.seq >= event.seq) return;
      const frame: ZakurabotToolFrame = { type: "tool_activity", agentId: c.agentId, message: {
        id: `tool_${createHash("sha256").update(JSON.stringify([run.runId, payload.toolCallId])).digest("hex")}`, agentId: c.agentId,
        role: "assistant", kind: "activity", createdAt: previous?.frame.message.createdAt ?? new Date(event.createdAt).getTime(),
        tool: { name: payload.name, ...(event.type === "tool_call_result" ? { ok: !payload.isError } : {}) },
      } };
      tools.set(payload.toolCallId, { seq: event.seq, frame });
      // Tool arguments/results and reasoning may contain secrets; only names/status leave the runtime.
      activity = activity.then(() => this.publish(c, frame)).catch(() => undefined);
    };
    const unsubscribe = this.deps.sessionStore.subscribe(run.sessionId, onEvent);
    try {
      const events = await this.deps.sessionStore.listEvents(run.sessionId, { limit: 2000 });
      events.forEach(onEvent);
      await waitForRemoteRun(run.handle.chat.thread(threadId), this.deps.sessionStore, run.sessionId, run.runId,
        { remoteHandle: run.handle, signal: run.abort.signal });
    } finally {
      unsubscribe();
      await activity;
      for (const { frame } of tools.values()) {
        if (frame.message.tool.ok === undefined) {
          frame.message.tool.interrupted = true;
          await this.publish(c, frame).catch(() => undefined);
        }
      }
      if (this.runs.get(threadId) === run) {
        this.runs.delete(threadId);
        await this.publish(c, { type: "typing", agentId: c.agentId, active: false },
          () => !this.runs.has(threadId)).catch(() => undefined);
      }
    }
  }

  async stop() {
    this.stopped = true;
    await Promise.allSettled(this.chains.values());
    for (const run of this.runs.values()) run.abort.abort();
    await Promise.all(Array.from(this.runs.values(), (run) => run.done));
    this.subscribers.clear();
    for (const [sessionId, handle] of this.handles) {
      if (this.deps.sessions.get(sessionId) === handle) this.deps.sessions.unbind(sessionId);
    }
    this.handles.clear();
  }

  async revalidateRuns() {
    for (const run of this.runs.values()) {
      try { await this.authorize(run.conversation); }
      catch (error) {
        if (!(error instanceof ZakurabotAccessError)) throw error;
        run.abort.abort();
        await this.deps.sessionStore.requestCancel(run.sessionId, run.runId);
      }
    }
  }
}
