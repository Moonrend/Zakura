import { createHash } from "node:crypto";
import { recordPlatformFault } from "@zakura/core";
import type { CloudAgentEvent } from "@zakura/shared";
import type { AgentChannelBinding } from "../db/schema.js";
import type { AgentService } from "./agents.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import { callRemoteChannelTool, formatRemoteInboundPrefix, type RemoteChannelSessionHandle, type RemoteChannelToolPort } from "./remote-channel-tools.js";
import { waitForRemoteRun } from "./remote-channel-stream.js";
import { createZakurabotChat } from "./zakurabot-adapter.js";
import type { ZakurabotAgent, ZakurabotClientFrame, ZakurabotServerFrame, ZakurabotToolFrame, ZakurabotUserFrame } from "./zakurabot-protocol.js";
import type { ZakurabotConversation, ZakurabotStore } from "./zakurabot-store.js";
import { ZakurabotFileError, type ZakurabotFileService } from "./zakurabot-files.js";
import { ZakurabotInteractionError, type ZakurabotInteractionService } from "./zakurabot-interactions.js";

export class ZakurabotAccessError extends Error {
  constructor(message: string, readonly closeCode: 4401 | 4403) { super(message); }
}

export class ZakurabotInputError extends Error {}

/** OAuth 登录后的租户成员；displayName 用于渠道内的发送者署名。 */
export type ZakurabotIdentity = { tenantId: string; userId: string; displayName?: string };
/** 从 OAuth access token 解析出活跃租户成员；无效/过期/非 api scope 返回 null。 */
export type ZakurabotPrincipalResolver = (token: string) => Promise<ZakurabotIdentity | null>;

type Subscriber = (conversation: ZakurabotConversation, frame: ZakurabotServerFrame) => Promise<void>;
type ActiveRun = { sessionId: string; runId: string; handle: RemoteChannelSessionHandle;
  conversation: ZakurabotConversation; abort: AbortController; done: Promise<void> };

export function zakurabotThreadId(c: ZakurabotConversation): string {
  return `zakurabot:${c.tenantId}:${c.deviceId}:${c.bindingId}:${c.agentId}`;
}

/**
 * Zakura Bot 是 Zakura 的一等功能：OAuth 登录后以用户自身权限访问租户全部 Agent。
 * 每个 Agent 首次被访问时自动获得一条启用的 zakurabot 绑定（内部路由实现细节），
 * 无需管理员预配，也不存在设备记录或独立的令牌体系。
 */
export class ZakurabotChannel {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly handles = new Map<string, RemoteChannelSessionHandle>();
  private readonly runSubscriptions = new Map<string, () => void>();
  private readonly trackedRunIds = new Map<string, string>();
  /** 热路径缓存：roster/agent 绑定（省去逐消息的列表查询）。成员有效性每次回查，保证封禁即时生效。 */
  private readonly rosterBindings = new Map<string, { at: number; bindings: AgentChannelBinding[] }>();
  private readonly agentBindings = new Map<string, { at: number; binding: AgentChannelBinding }>();
  private stopped = false;

  constructor(readonly deps: {
    store: ZakurabotStore;
    ingress: import("./remote-agent-ingress.js").RemoteAgentIngress;
    sessions: RemoteChannelToolPort;
    sessionStore: CloudAgentSessionStore;
    agents: Pick<AgentService, "get" | "list">;
    files?: ZakurabotFileService;
    interactions?: ZakurabotInteractionService;
    desktopAvailable?: boolean;
    publishFile: (conversation: ZakurabotConversation, path: string) => Promise<{ url: string; name: string }>;
    principal: ZakurabotPrincipalResolver;
  }) {}

  capabilities(): string[] {
    return ["agents", "history", ...(this.deps.files ? ["files"] : []),
      ...(this.deps.desktopAvailable ? ["desktop_frames"] : []), ...(this.deps.interactions ? ["interactions"] : [])];
  }

  resolvePrincipal(token: string) {
    return this.deps.principal(token);
  }

  /** 成员身份变化（封禁/移除）时立即生效；绑定缓存随之失效以便重新评估。 */
  forgetAccess(tenantId: string, userId: string) {
    void userId;
    this.rosterBindings.delete(tenantId);
    this.agentBindings.clear();
  }

  private senderName(identity: ZakurabotIdentity): string {
    return identity.displayName?.trim() || "Zakura Bot";
  }

  private async requireActiveUser(tenantId: string, userId: string) {
    const user = await this.deps.store.getActiveUser(tenantId, userId);
    if (!user) throw new ZakurabotAccessError("Sign in with an active Zakura account", 4401);
    return user;
  }

  /** 找到或开通某 Agent 的 zakurabot 绑定；已禁用的绑定保持禁用（管理员可切断访问）。 */
  private async ensureAgentBinding(tenantId: string, agentId: string): Promise<AgentChannelBinding | null> {
    const key = `${tenantId}:${agentId}`;
    const cached = this.agentBindings.get(key);
    if (cached && Date.now() - cached.at < 10_000) return cached.binding;
    const existing = (await this.deps.ingress.listBindings(tenantId, "zakurabot"))
      .find((binding) => binding.agentId === agentId);
    if (existing) {
      // 设备时代的绑定默认是空白名单=拒绝；用户模型下升级为开放，访问控制由会话本身承担。
      const settings = this.deps.ingress.toBindingView(existing)!.settings;
      const restrictive = settings.allowAll !== true && !(settings.allowedUsers?.length || settings.allowedEmails?.length);
      const binding = !restrictive ? existing : await this.serial(`provision:${tenantId}`, () =>
        this.deps.ingress.saveBinding(tenantId, { id: existing.id, agentId, platform: "zakurabot",
          profileKey: "remote-zakurabot", enabled: true, settings: { allowAll: true } }));
      this.agentBindings.set(key, { at: Date.now(), binding: binding ?? existing });
      return binding ?? existing;
    }
    if (!await this.deps.agents.get(tenantId, agentId)) return null;
    const binding = await this.serial(`provision:${tenantId}`, async () => {
      const current = (await this.deps.ingress.listBindings(tenantId, "zakurabot"))
        .find((row) => row.agentId === agentId);
      if (current) return current;
      // allowAll 保持入站 ACL 开放；访问控制由用户会话本身承担。
      return this.deps.ingress.saveBinding(tenantId, {
        agentId, platform: "zakurabot", profileKey: "remote-zakurabot",
        enabled: true, label: "Zakura Bot", settings: { allowAll: true },
      });
    });
    if (!binding) return null;
    this.agentBindings.set(key, { at: Date.now(), binding });
    return binding;
  }

  private async ensureRosterBindings(tenantId: string, agents: { id: string }[]): Promise<AgentChannelBinding[]> {
    const cached = this.rosterBindings.get(tenantId);
    if (cached && Date.now() - cached.at < 5_000) return cached.bindings;
    const known = new Set(agents.map((agent) => agent.id));
    const all = (await this.deps.ingress.listBindings(tenantId, "zakurabot"))
      .filter((binding) => known.has(binding.agentId));
    // 只有从未开通过的 Agent 才补建；禁用的绑定保持禁用（管理员可切断访问）。
    const bindings = all.filter((binding) => binding.enabled);
    const bound = new Set(all.map((binding) => binding.agentId));
    const missing = agents.filter((agent) => !bound.has(agent.id));
    const legacy = bindings.filter((binding) => {
      const settings = this.deps.ingress.toBindingView(binding)!.settings;
      return settings.allowAll !== true && !(settings.allowedUsers?.length || settings.allowedEmails?.length);
    });
    if (missing.length || legacy.length) {
      await this.serial(`provision:${tenantId}`, async () => {
        for (const agent of missing) {
          try {
            bindings.push(await this.deps.ingress.saveBinding(tenantId, {
              agentId: agent.id, platform: "zakurabot", profileKey: "remote-zakurabot",
              enabled: true, label: "Zakura Bot", settings: { allowAll: true },
            }));
          } catch { /* 已由并发路径开通时忽略 */ }
        }
        for (const binding of legacy) {
          try {
            const upgraded = await this.deps.ingress.saveBinding(tenantId, { id: binding.id,
              agentId: binding.agentId, platform: "zakurabot", profileKey: "remote-zakurabot",
              enabled: true, settings: { allowAll: true } });
            const index = bindings.findIndex((row) => row.id === binding.id);
            if (index >= 0 && upgraded) bindings[index] = upgraded;
          } catch { /* 保留原 ACL */ }
        }
      });
    }
    this.rosterBindings.set(tenantId, { at: Date.now(), bindings });
    return bindings;
  }

  private conversation(identity: ZakurabotIdentity, binding: AgentChannelBinding): ZakurabotConversation {
    return { tenantId: identity.tenantId, deviceId: identity.userId, bindingId: binding.id, agentId: binding.agentId };
  }

  /** 授权校验：绑定仍存在、仍启用且指向同一 Agent。 */
  private async authorize(c: ZakurabotConversation) {
    await this.requireActiveUser(c.tenantId, c.deviceId);
    const binding = await this.deps.ingress.getBinding(c.tenantId, c.bindingId);
    if (!binding || binding.platform !== "zakurabot" || binding.agentId !== c.agentId || !binding.enabled) {
      throw new ZakurabotAccessError("This conversation is no longer available", 4403);
    }
    return binding;
  }

  async roster(identity: ZakurabotIdentity) {
    if (this.stopped) throw new Error("Zakura Bot is stopping");
    await this.requireActiveUser(identity.tenantId, identity.userId);
    const tenantAgents = await this.deps.agents.list(identity.tenantId);
    const bindings = await this.ensureRosterBindings(identity.tenantId, tenantAgents);
    const agents: ZakurabotAgent[] = [];
    const conversations: ZakurabotConversation[] = [];
    for (const binding of bindings) {
      // 重复绑定按歧义处理，失败关闭。
      if (bindings.filter((b) => b.agentId === binding.agentId).length !== 1) continue;
      const agent = tenantAgents.find((row) => row.id === binding.agentId);
      if (!agent) continue;
      const c = this.conversation(identity, binding);
      const status = await this.deps.ingress.getThreadStatus(identity.tenantId, binding.id, zakurabotThreadId(c));
      agents.push({ id: agent.id, name: agent.name || "Agent", title: binding.label, description: agent.description,
        status: status?.activeRunId ? "busy" : "idle", color: "#1084fe", unread: false, bindingId: binding.id,
        capabilities: { files: Boolean(agent.enableFs && this.deps.files), desktop: Boolean(agent.enableComputer && this.deps.desktopAvailable),
          interactions: Boolean(this.deps.interactions) } });
      conversations.push(c);
    }
    return { agents, conversations };
  }

  subscribe(identity: ZakurabotIdentity, subscriber: Subscriber): () => void {
    const key = `${identity.tenantId}:${identity.userId}`;
    const listeners = this.subscribers.get(key) ?? new Set<Subscriber>();
    listeners.add(subscriber);
    this.subscribers.set(key, listeners);
    return () => { listeners.delete(subscriber); if (!listeners.size) this.subscribers.delete(key); };
  }

  async history(c: ZakurabotConversation, limit?: number) {
    await this.authorize(c);
    const status = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, zakurabotThreadId(c));
    if (status) await this.watchInteractions(c, status.sessionId);
    return this.deps.store.history(c, limit);
  }

  private async watchInteractions(c: ZakurabotConversation, sessionId: string) {
    if (this.deps.interactions && !this.runSubscriptions.has(sessionId)) {
      this.runSubscriptions.set(sessionId, this.deps.sessionStore.subscribe(sessionId, (event) => {
        if (event.type !== "run_start" || !event.runId) return;
        const handle = this.deps.sessions.get(sessionId);
        if (!handle || handle !== this.handles.get(sessionId)) return;
        this.trackRun(c, sessionId, event.runId, handle, true);
      }));
    }
    await this.deps.interactions?.watch(c, sessionId, async (row, interaction) => {
      await this.authorize(c);
      const current = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, zakurabotThreadId(c));
      if (current?.sessionId !== sessionId) return;
      const threadId = zakurabotThreadId(c);
      const chat = createZakurabotChat({ agentId: c.agentId, deviceId: c.deviceId, deviceName: "Zakura Bot", threadId,
        interaction,
        history: (limit) => this.history(c, limit), publishFile: (path) => this.deps.publishFile(c, path),
        post: async (frame) => {
          if (frame.type === "chat_reply") {
            await this.publish(c, { ...frame, messageId: row.id, createdAt: row.createdAt.getTime() });
          }
        },
      });
      const handle: RemoteChannelSessionHandle = { chat, platform: "zakurabot", bindingId: c.bindingId,
        threadId, channelId: threadId, inboundMessageId: row.replyTo ?? undefined };
      const state = interaction.status === "pending" ? "等待回答" : interaction.status === "answered" ? "已回答" :
        interaction.status === "cancelled" ? "已取消" : interaction.status === "timeout" ? "已超时" : "已结束";
      const result = await callRemoteChannelTool(handle, "chat_reply", {
        text: interaction.title, kind: "card",
        card: { title: interaction.title, subtitle: state,
          fields: interaction.options?.map((option) => ({ label: option.label, value: option.description ?? "" })),
          links: interaction.url ? [{ label: "打开", url: interaction.url }] : undefined },
      });
      if (result.isError) throw new Error("Could not deliver interaction through chat_reply");
      const run = this.runs.get(threadId);
      const bound = this.deps.sessions.get(sessionId);
      const handleForRun = run?.runId === row.runId ? run.handle : bound && bound === this.handles.get(sessionId) &&
        (await this.deps.sessionStore.getSession(c.tenantId, c.agentId, sessionId))?.activeRunId === row.runId ? bound : undefined;
      if (handleForRun) handleForRun.chatReplySuccessCount = (handleForRun.chatReplySuccessCount ?? 0) + 1;
    });
  }

  async interactionSession(identity: ZakurabotIdentity, agentId: string) {
    const { conversation } = await this.resolveConversation(identity, agentId);
    const status = await this.deps.ingress.getThreadStatus(conversation.tenantId, conversation.bindingId, zakurabotThreadId(conversation));
    if (!status) return { conversation, sessionId: null };
    await this.watchInteractions(conversation, status.sessionId);
    return { conversation, sessionId: status.sessionId };
  }

  async respondInteraction(identity: ZakurabotIdentity, agentId: string, messageId: string,
    input: Parameters<ZakurabotInteractionService["respond"]>[3]) {
    if (!this.deps.interactions) throw new ZakurabotInteractionError("Interactions are unavailable", 503);
    const { conversation: c, sessionId } = await this.interactionSession(identity, agentId);
    if (!sessionId) throw new ZakurabotInteractionError("Interaction not found in this conversation", 404);
    const snapshot = await this.deps.interactions.snapshot(c, messageId, sessionId);
    // An async answer may start a follow-up after a server restart, with no inbound send to bind its tools.
    if (snapshot.interaction.type === "question" && snapshot.interaction.mode === "async" &&
      snapshot.interaction.status === "pending" && !this.deps.sessions.get(sessionId)) {
      await this.restoreHandle(c, sessionId, snapshot.replyTo);
    }
    // Startup can itself await an answer. The database claim serializes answers without blocking on send.
    return this.deps.interactions.respond(c, sessionId, messageId, input, async () => {
      await this.authorize(c);
      const current = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, zakurabotThreadId(c));
      if (current?.sessionId !== sessionId) throw new ZakurabotInteractionError("Interaction session has changed", 409);
    });
  }

  private async syncRunInteractions(run: ActiveRun) {
    await this.deps.interactions?.sync(run.sessionId);
    // A fast startup may have delivered its card before startTurn returned the run ID.
    if (!run.abort.signal.aborted && !(run.handle.chatReplySuccessCount ?? 0) &&
      await this.deps.interactions?.hasDeliveredReply(run.conversation, run.sessionId, run.runId)) {
      if (!run.abort.signal.aborted) run.handle.chatReplySuccessCount = Math.max(1, run.handle.chatReplySuccessCount ?? 0);
    }
  }

  private async restoreHandle(c: ZakurabotConversation, sessionId: string, replyTo?: string, identity?: ZakurabotIdentity) {
    await this.authorize(c);
    if (this.deps.sessions.get(sessionId)) return;
    const threadId = zakurabotThreadId(c);
    const sender = this.senderName(identity ?? { tenantId: c.tenantId, userId: c.deviceId });
    const requireCurrent = () => {
      if (this.deps.sessions.get(sessionId) !== handle) throw new Error("This remote turn has been superseded");
    };
    const chat = createZakurabotChat({ agentId: c.agentId, deviceId: c.deviceId, deviceName: sender, threadId,
      post: (frame) => this.publish(c, frame, () => { requireCurrent(); return true; }),
      history: (limit) => { requireCurrent(); return this.history(c, limit); },
      publishFile: async (path) => { requireCurrent(); await this.authorize(c); return this.deps.publishFile(c, path); },
    });
    const handle: RemoteChannelSessionHandle = { chat, threadId, channelId: threadId, platform: "zakurabot", bindingId: c.bindingId,
      inboundMessageId: replyTo, isDM: true, isThread: false, trigger: "dm",
      sender: { userId: c.deviceId, userName: sender, fullName: sender }, chatReplySuccessCount: 0, autoFallbackPosted: false };
    this.deps.sessions.bind(sessionId, handle);
    this.handles.set(sessionId, handle);
  }

  private trackRun(c: ZakurabotConversation, sessionId: string, runId: string, handle: RemoteChannelSessionHandle, resetCounters = false) {
    const threadId = zakurabotThreadId(c);
    const previous = this.runs.get(threadId);
    if (this.trackedRunIds.get(sessionId) === runId) return;
    this.trackedRunIds.set(sessionId, runId);
    previous?.abort.abort();
    if (resetCounters) {
      handle.chatReplySuccessCount = 0;
      handle.autoFallbackPosted = false;
    }
    const run: ActiveRun = { sessionId, runId, handle, conversation: c, abort: new AbortController(), done: Promise.resolve() };
    this.runs.set(threadId, run);
    run.done = this.observeRun(run).catch((error) => {
      recordPlatformFault("zakurabot.run", error, { subsystem: "remote_agent" });
    });
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
    if (this.stopped) throw new Error("Zakura Bot is stopping");
    await this.requireActiveUser(identity.tenantId, identity.userId);
    const binding = await this.ensureAgentBinding(identity.tenantId, agentId);
    if (!binding || !binding.enabled) throw new ZakurabotAccessError("This device cannot access the requested agent", 4403);
    return { device: identity, conversation: this.conversation(identity, binding) };
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.chains.set(key, current);
    return current.finally(() => { if (this.chains.get(key) === current) this.chains.delete(key); });
  }

  async send(identity: ZakurabotIdentity, frame: Extract<ZakurabotClientFrame, { type: "send" }>) {
    const { conversation: c } = await this.resolveConversation(identity, frame.agentId);
    const threadId = zakurabotThreadId(c);
    const sender = this.senderName(identity);
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
        agentId: c.agentId, deviceId: c.deviceId, deviceName: sender, threadId,
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
        sender: { userId: c.deviceId, userName: sender, fullName: sender },
        chatReplySuccessCount: 0, autoFallbackPosted: false,
      };
      const result = await this.deps.ingress.handleInbound({
        tenantId: c.tenantId, bindingId: c.bindingId, platform: "zakurabot",
        externalEventId: `${threadId}:${frame.clientMessageId}`, externalThreadKey: threadId,
        externalUserKey: c.deviceId, text: `${formatRemoteInboundPrefix(handle)}\n${text}`,
        attachments: files?.attachments,
        title: `Zakura Bot · ${sender}`,
        onSessionReady: async (sessionId) => {
          const previous = this.runs.get(threadId);
          previous?.abort.abort();
          await previous?.done;
          await this.authorize(c);
          await this.publish(c, echo);
          this.deps.sessions.bind(sessionId, handle);
          boundSessionId = sessionId;
          this.handles.set(sessionId, handle);
          await this.watchInteractions(c, sessionId);
        },
      });
      if (!result.accepted) throw new ZakurabotAccessError("Message rejected by the remote channel binding", 4403);
      if (result.duplicate) { await this.publish(c, echo); return; }
      this.trackRun(c, result.sessionId, result.runId, handle);
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
    const { conversation: c } = await this.resolveConversation(identity, agentId);
    const threadId = zakurabotThreadId(c);
    const sender = this.senderName(identity);
    return this.serial(threadId, async () => {
      await this.authorize(c);
      const current = await this.deps.ingress.getThreadStatus(c.tenantId, c.bindingId, threadId);
      if (action === "stop") await this.deps.ingress.stopThreadRun(c.tenantId, c.bindingId, threadId);
      if (action === "new" || (action === "start" && !current)) {
        if (current) await this.deps.interactions?.cancelSession(c, current.sessionId);
        await this.deps.ingress.resetThreadSession(c.tenantId, c.bindingId, threadId, c.deviceId, `Zakura Bot · ${sender}`);
        const previous = this.runs.get(threadId);
        previous?.abort.abort();
        await previous?.done;
        if (current && this.deps.sessions.get(current.sessionId) === this.handles.get(current.sessionId)) {
          this.deps.sessions.unbind(current.sessionId);
          this.handles.delete(current.sessionId);
        }
        if (current) await this.deps.interactions?.unwatch(current.sessionId);
        if (current) {
          this.runSubscriptions.get(current.sessionId)?.();
          this.runSubscriptions.delete(current.sessionId);
          this.trackedRunIds.delete(current.sessionId);
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
      await this.syncRunInteractions(run);
      await waitForRemoteRun(run.handle.chat.thread(threadId), this.deps.sessionStore, run.sessionId, run.runId,
        { remoteHandle: run.handle, signal: run.abort.signal,
          beforeFallback: () => this.syncRunInteractions(run) });
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
    for (const unsubscribe of this.runSubscriptions.values()) unsubscribe();
    this.runSubscriptions.clear();
    this.trackedRunIds.clear();
    await this.deps.interactions?.close();
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

  /** 管理操作后的强制刷新：绕过 roster 缓存，让新 Agent 立刻可见。 */
  async refresh() {
    this.rosterBindings.clear();
    this.agentBindings.clear();
    await this.revalidateRuns();
  }
}
