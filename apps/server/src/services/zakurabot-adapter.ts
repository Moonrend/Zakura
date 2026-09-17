import { newId } from "../db/schema.js";
import type { AgentService } from "./agents.js";
import type { FileShareService } from "./file-shares.js";
import type { ServerWorkspaceFsProvider } from "./workspace-fs-provider.js";
import type { ZakurabotConversation } from "./zakurabot-store.js";
import type { RemoteChatHandle } from "./remote-channel-tools.js";
import { encodeZakurabotReply, zakurabotReplySchema, type ZakurabotInteractionPayload, type ZakurabotServerFrame, type ZakurabotStoredFrame } from "./zakurabot-protocol.js";

export function createZakurabotFilePublisher(deps: {
  agents: Pick<AgentService, "get">;
  fileShares?: FileShareService;
  workspaceFs?: Pick<ServerWorkspaceFsProvider, "forAgentBinding">;
}) {
  return async (conversation: ZakurabotConversation, path: string) => {
    if (!deps.fileShares || !deps.workspaceFs) throw new Error("工作区文件分享未启用");
    const agent = await deps.agents.get(conversation.tenantId, conversation.agentId);
    if (!agent?.enableFs) throw new Error("Agent 工作区文件访问未启用");
    const fs = await deps.workspaceFs.forAgentBinding(agent);
    const stat = await fs.stat(path);
    if (stat.type !== "file" || !stat.size || stat.size > 16 * 1024 * 1024) {
      throw new Error("附件必须是非空文件，且不超过 16MB");
    }
    const share = await deps.fileShares.create(conversation.tenantId, conversation.agentId, fs,
      { path, ttlMinutes: 60, disposition: "inline" });
    return { url: share.url, name: share.fileName };
  };
}

/** A DM-scoped RemoteChatHandle. Tools cannot address another device, agent, or tenant. */
export function createZakurabotChat(input: {
  agentId: string;
  deviceId: string;
  deviceName: string;
  threadId: string;
  post: (frame: ZakurabotServerFrame) => Promise<void>;
  history: (limit?: number) => Promise<ZakurabotStoredFrame[]>;
  publishFile: (path: string) => Promise<{ url: string; name: string }>;
  /** Only the event projector can attach an actionable interaction to a reply. */
  interaction?: ZakurabotInteractionPayload;
}): RemoteChatHandle {
  const requireThread = (id: string) => {
    if (id !== input.threadId) throw new Error("Zakura Bot can only access the current conversation");
  };
  const user = { userId: input.deviceId, userName: input.deviceName, fullName: input.deviceName, isBot: false };
  const post = async (message: unknown, replyTo?: string) => {
    const payload = zakurabotReplySchema.parse({ ...(message as object), ...(replyTo ? { reply_to: replyTo } : {}) });
    const id = newId();
    await input.post({ type: "chat_reply", agentId: input.agentId, messageId: id, createdAt: Date.now(), payload });
    return { id, threadId: input.threadId };
  };
  const thread = {
    id: input.threadId, channelId: input.threadId, isDM: true,
    post,
    reply: (target: string | { id: string }, message: unknown) => post(message, typeof target === "string" ? target : target.id),
    async startTyping() { await input.post({ type: "typing", agentId: input.agentId, active: true }); },
    adapter: {
      async addReaction(threadId: string, _messageId: string, emoji: string) {
        requireThread(threadId);
        await input.post({ type: "tool_activity", agentId: input.agentId, message: {
          id: newId(), agentId: input.agentId, role: "assistant", kind: "activity", createdAt: Date.now(),
          tool: { name: "chat_add_reaction", ok: true, detail: emoji.slice(0, 128) },
        } });
      },
      async fetchMessages(threadId: string, options?: { limit?: number }) {
        requireThread(threadId);
        const frames = await input.history(options?.limit);
        return { messages: frames.map((frame) => frame.type === "message" ? {
          id: frame.message.id, threadId, text: frame.message.text, author: user,
          dateSent: new Date(frame.message.createdAt).toISOString(),
        } : {
          id: frame.messageId, threadId, text: frame.payload.text ?? frame.payload.card?.text ?? "",
          author: { userId: input.agentId, isBot: true }, dateSent: new Date(frame.createdAt).toISOString(),
        }) };
      },
    },
    async getParticipants() { return [user]; },
  };
  return {
    encodePostable: (args) => {
      if (args.interaction !== undefined) throw new Error("Use ask_user to request an answer; interaction IDs are server-managed");
      return encodeZakurabotReply({ ...args, interaction: input.interaction }, input.publishFile);
    },
    thread(id) { requireThread(id); return thread; },
    channel(id) {
      requireThread(id);
      return { id, name: input.deviceName, isDM: true, post,
        async info() { return { name: input.deviceName, memberCount: 2, channelVisibility: "private" }; } };
    },
    async openDM(userId) {
      if (userId !== input.deviceId) throw new Error("Zakura Bot can only message the current device");
      return thread;
    },
    async getUser(userId) { return userId === input.deviceId ? user : null; },
  };
}
