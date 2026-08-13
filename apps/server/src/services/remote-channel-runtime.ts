import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createGoogleChatAdapter } from "@chat-adapter/gchat";
import { createLinearAdapter } from "@chat-adapter/linear";
import { createMessengerAdapter } from "@chat-adapter/messenger";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createTwilioAdapter } from "@chat-adapter/twilio";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import { createWebexAdapter } from "@bitbasti/chat-adapter-webex";
import { createMattermostAdapter } from "chat-adapter-mattermost";
import { createWeixinAdapter } from "chat-adapter-weixin";
import { createPostgresState, type PostgresStateAdapter } from "@chat-adapter/state-pg";
import { createMemoryState, type MemoryStateAdapter } from "@chat-adapter/state-memory";
import { randomBytes } from "node:crypto";
import { recordPlatformFault } from "@zakura/core";
import type { AppConfig } from "../config.js";
import { platformEvents } from "./platform-events.js";
import type { ConnectorAuthService } from "./connector-auth.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import type {
  RemoteAgentIngress,
  RemoteInboundMessage,
} from "./remote-agent-ingress.js";
import {
  acknowledgeInboundMessage,
  deliverRunToThread,
} from "./remote-channel-stream.js";
import {
  REMOTE_SLASH_NAMES,
  accessDeniedHint,
  formatHelp,
  formatStartWelcome,
  formatWhoami,
  isPublicSlashCommand,
  normalizeCommandName,
  parseSlashFromText,
  registerPlatformSlashCommands,
  settingsHasPending,
} from "./remote-channel-commands.js";
import {
  RemoteChannelSessionRegistry,
  type RemoteChannelToolPort,
  type RemoteChatHandle,
} from "./remote-channel-tools.js";
import type { RemoteChannelSettings } from "./remote-agent-ingress.js";

export const CHAT_SDK_PLATFORMS = [
  "slack",
  "teams",
  "gchat",
  "discord",
  "telegram",
  "github",
  "linear",
  "whatsapp",
  "twilio",
  "messenger",
  "resend",
  "webex",
  "mattermost",
  "weixin",
] as const;

export const REMOTE_PLATFORMS = [...CHAT_SDK_PLATFORMS] as const;

export type ChatSdkPlatform = (typeof CHAT_SDK_PLATFORMS)[number];
export type RemotePlatform = (typeof REMOTE_PLATFORMS)[number];

type Adapter = {
  handleWebhook?: (request: Request, options?: { waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>;
};

type Bot = RemoteChatHandle & {
  webhooks: Record<string, (request: Request, options?: unknown) => Promise<Response>>;
  onDirectMessage(handler: (thread: any, message: any) => Promise<void>): void;
  onNewMention(handler: (thread: any, message: any) => Promise<void>): void;
  onSubscribedMessage(handler: (thread: any, message: any) => Promise<void>): void;
  onSlashCommand(
    commandOrHandler: string | string[] | ((event: any) => Promise<void>),
    handler?: (event: any) => Promise<void>,
  ): void;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
};

type AdapterFactory = (config: Record<string, unknown>) => Adapter;

const adapterFactories: Record<ChatSdkPlatform, AdapterFactory> = {
  slack: (config) => createSlackAdapter(config as never),
  teams: (config) => createTeamsAdapter(config as never),
  gchat: (config) => createGoogleChatAdapter(config as never),
  discord: (config) => createDiscordAdapter(config as never),
  telegram: (config) => createTelegramAdapter(config as never),
  github: (config) => createGitHubAdapter(config as never),
  linear: (config) => createLinearAdapter(config as never),
  whatsapp: (config) => createWhatsAppAdapter(config as never),
  twilio: (config) => createTwilioAdapter(config as never),
  messenger: (config) => createMessengerAdapter(config as never),
  resend: (config) => createResendAdapter(config as never),
  webex: (config) => createWebexAdapter(config as never),
  mattermost: (config) => createMattermostAdapter(config as never),
  weixin: (config) => createWeixinAdapter(config as never),
};

function isPlatform(value: string): value is RemotePlatform {
  return (REMOTE_PLATFORMS as readonly string[]).includes(value);
}

function isChatSdkPlatform(value: string): value is ChatSdkPlatform {
  return (CHAT_SDK_PLATFORMS as readonly string[]).includes(value);
}

function authorKey(message: any): string {
  const author = message?.author ?? {};
  return String(author.userId ?? author.id ?? author.userName ?? author.fullName ?? "unknown");
}

function senderEmail(message: any): string | undefined {
  const email = message?.author?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

function prepareAdapterConfig(platform: RemotePlatform, values: Record<string, unknown>) {
  const config = { ...values };
  if (platform === "gchat" && typeof config.credentials === "string") {
    try {
      config.credentials = JSON.parse(config.credentials);
    } catch {
      throw new Error("Google Chat credentials 必须是有效的 Service Account JSON");
    }
  }
  if (platform === "github" && typeof config.installationId === "string") {
    const installationId = Number(config.installationId);
    if (Number.isFinite(installationId)) config.installationId = installationId;
  }
  if (platform === "telegram" && config.secretToken === undefined && config.webhookSecret !== undefined) {
    config.secretToken = config.webhookSecret;
    delete config.webhookSecret;
  }
  if (platform === "telegram" && config.mode === undefined) {
    config.mode = "webhook";
  }
  return config;
}

export class RemoteChannelRuntime {
  private readonly bots = new Map<string, Bot>();
  private readonly states = new Map<string, PostgresStateAdapter | MemoryStateAdapter>();
  readonly sessions: RemoteChannelToolPort = new RemoteChannelSessionRegistry();

  constructor(
    private readonly config: AppConfig,
    private readonly auth: ConnectorAuthService,
    private readonly ingress: RemoteAgentIngress,
    private readonly store: CloudAgentSessionStore,
  ) {}

  async handleWebhook(tenantId: string, bindingId: string, request: Request): Promise<Response> {
    const binding = await this.ingress.getBinding(tenantId, bindingId);
    if (!binding || !isPlatform(binding.platform)) {
      return Response.json({ error: "远程连接不存在或平台不支持" }, { status: 404 });
    }
    const bot = await this.getBot(tenantId, binding);
    const handler = bot.webhooks[binding.platform];
    if (!handler) return Response.json({ error: "平台 webhook 未注册" }, { status: 501 });
    return handler(request, {
      waitUntil: (promise: Promise<unknown>) => {
        void promise.catch((error) => {
          recordPlatformFault("remote_agent.webhook_async", error, {
            subsystem: "remote_agent",
          });
        });
      },
    });
  }

  async invalidate(bindingId: string): Promise<void> {
    const bot = this.bots.get(bindingId);
    if (bot) {
      this.bots.delete(bindingId);
      await bot.shutdown().catch(() => undefined);
    }
    const state = this.states.get(bindingId);
    if (state) {
      this.states.delete(bindingId);
      await state.disconnect().catch(() => undefined);
    }
  }

  async startBinding(tenantId: string, bindingId: string): Promise<void> {
    const binding = await this.ingress.getBinding(tenantId, bindingId);
    if (!binding || !binding.enabled || !isChatSdkPlatform(binding.platform)) return;
    await this.getBot(tenantId, binding);
  }

  async startTenant(tenantId: string): Promise<void> {
    const bindings = await this.ingress.listBindings(tenantId);
    for (const binding of bindings) {
      if (!binding.enabled || !isChatSdkPlatform(binding.platform)) continue;
      try {
        await this.startBinding(tenantId, binding.id);
      } catch (error) {
        recordPlatformFault("remote_agent.start_binding", error, {
          subsystem: "remote_agent",
        });
      }
    }
  }

  async stop(): Promise<void> {
    for (const bot of this.bots.values()) await bot.shutdown().catch(() => undefined);
    this.bots.clear();
    for (const state of this.states.values()) await state.disconnect().catch(() => undefined);
    this.states.clear();
  }

  private async resolveCredentials(
    tenantId: string,
    binding: { id: string; platform: string; profileKey: string; configEnc?: string | null },
  ): Promise<{ enabled: boolean; values: Record<string, unknown> }> {
    const full = await this.ingress.getBinding(tenantId, binding.id);
    if (full) {
      const local = this.ingress.getBindingCredentials(full);
      if (local.configuredFields.length > 0 || local.enabled) {
        return { enabled: local.enabled, values: local.values };
      }
    }
    // Legacy fallback: copy tenant-shared connector profile into this binding once.
    const legacyKeys = [
      binding.profileKey,
      binding.profileKey.includes(":") ? binding.profileKey.split(":")[0]! : "",
      `remote-${binding.platform}`,
    ].filter(Boolean);
    for (const key of [...new Set(legacyKeys)]) {
      const profile = await this.auth.getProfile(tenantId, key);
      if (!profile || Object.keys(profile.values).length === 0) continue;
      try {
        const row = full ?? (await this.ingress.getBinding(tenantId, binding.id));
        if (row) {
          await this.ingress.saveBinding(tenantId, {
            id: row.id,
            agentId: row.agentId,
            platform: row.platform,
            profileKey: row.profileKey,
            credentials: profile.values,
            credentialsEnabled: profile.enabled,
          });
        }
      } catch {
        /* keep using in-memory legacy values for this start */
      }
      return { enabled: profile.enabled, values: profile.values };
    }
    return { enabled: false, values: {} };
  }

  private async tryRegisterTelegramWebhook(
    tenantId: string,
    binding: { id: string; platform: string; profileKey: string; agentId?: string },
  ): Promise<void> {
    if (binding.platform !== "telegram") return;
    const creds = await this.resolveCredentials(tenantId, binding);
    if (!creds.enabled) return;

    const values = prepareAdapterConfig("telegram", creds.values);
    if (String(values.mode ?? "webhook") === "polling") return;

    const botToken = typeof values.botToken === "string" ? values.botToken.trim() : "";
    if (!botToken) return;

    const webhookUrl = `${this.config.publicBaseUrl.replace(/\/$/, "")}/api/remote-channels/${tenantId}/${binding.id}/webhook`;
    const secretToken =
      typeof values.secretToken === "string" && values.secretToken.trim()
        ? values.secretToken.trim()
        : randomBytes(32).toString("base64url");
    if (values.secretToken !== secretToken) {
      await this.ingress.mergeBindingCredentials(tenantId, binding.id, { secretToken });
    }
    const body = JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
    });
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(10_000),
          },
        );
        const result = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          description?: string;
        };
        if (!response.ok || result.ok !== true) {
          throw new Error(result.description || `Telegram HTTP ${response.status}`);
        }
        platformEvents.publish(tenantId, {
          type: "connector_notice",
          agentId: binding.agentId ?? "",
          bindingId: binding.id,
          platform: "telegram",
          level: "ok",
          message: "Telegram webhook 已登记",
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }

    recordPlatformFault("remote_agent.telegram_webhook", lastError, {
      subsystem: "remote_agent",
    });
    platformEvents.publish(tenantId, {
      type: "connector_notice",
      agentId: binding.agentId ?? "",
      bindingId: binding.id,
      platform: "telegram",
      level: "error",
      message: "Telegram webhook 登记失败，请检查 Bot Token 与公网地址",
    });
  }

  private async stateFor(
    tenantId: string,
    bindingId: string,
  ): Promise<PostgresStateAdapter | MemoryStateAdapter> {
    const existing = this.states.get(bindingId);
    if (existing) return existing;
    const state = this.config.databaseUrl.startsWith("pglite:")
      ? createMemoryState()
      : createPostgresState({
          url: this.config.databaseUrl,
          keyPrefix: `recloud:remote:${tenantId}:${bindingId}`,
        });
    await state.connect();
    this.states.set(bindingId, state);
    return state;
  }

  private async getBot(
    tenantId: string,
    binding: { id: string; platform: string; profileKey: string; agentId?: string },
  ): Promise<Bot> {
    const existing = this.bots.get(binding.id);
    if (existing) return existing;
    if (!isChatSdkPlatform(binding.platform)) throw new Error(`不支持远程平台: ${binding.platform}`);
    await this.tryRegisterTelegramWebhook(tenantId, binding);
    const creds = await this.resolveCredentials(tenantId, binding);
    if (!creds.enabled) throw new Error("远程连接凭据未启用");

    const adapterConfig = prepareAdapterConfig(binding.platform, creds.values);
    const adapter = adapterFactories[binding.platform](adapterConfig);
    const state = await this.stateFor(tenantId, binding.id);
    const bot = new Chat({
      userName: `reCloud-${binding.platform}`,
      adapters: { [binding.platform]: adapter },
      state,
    } as never) as unknown as Bot;

    const reply = async (target: { post: (msg: unknown) => Promise<unknown> }, text: string) => {
      await target.post(text);
    };

    const handleSlash = async (input: {
      post: (msg: unknown) => Promise<unknown>;
      threadKey: string;
      command: string;
      args: string;
      userKey: string;
      email?: string;
      displayName?: string;
    }) => {
      const name = normalizeCommandName(input.command);
      if (!name) return;
      const allowed = await this.ingress.isAllowed(
        tenantId,
        binding.id,
        input.userKey,
        input.email,
      );
      if (!allowed && !isPublicSlashCommand(name)) {
        await reply(input, accessDeniedHint(input.userKey));
        return;
      }

      const settings =
        (await this.ingress.getSettings(tenantId, binding.id)) ?? ({} as RemoteChannelSettings);

      switch (name) {
        case "start":
          await reply(input, formatStartWelcome(allowed, input.userKey));
          return;
        case "help":
          await reply(input, formatHelp(allowed));
          return;
        case "whoami":
          await reply(
            input,
            formatWhoami({
              userKey: input.userKey,
              email: input.email,
              allowed,
              allowAll: settings.allowAll === true,
              pending: settingsHasPending(settings, input.userKey),
            }),
          );
          return;
        case "request": {
          const result = await this.ingress.requestAccess(tenantId, binding.id, {
            userKey: input.userKey,
            email: input.email,
            displayName: input.displayName,
            threadKey: input.threadKey,
          });
          if (result.status === "allowed") {
            await reply(input, "你已经有访问权限，直接发消息即可。");
          } else if (result.status === "pending") {
            await reply(input, "申请已在队列中，请等待管理员审批。");
          } else {
            await reply(
              input,
              `已提交访问申请。\n用户 ID：\`${input.userKey}\`\n请等待管理员在控制台白名单中批准。`,
            );
          }
          return;
        }
        case "status": {
          const status = await this.ingress.getThreadStatus(
            tenantId,
            binding.id,
            input.threadKey,
          );
          await reply(
            input,
            status
              ? `Agent 状态：${status.activeRunId ? "运行中" : "空闲"}\n会话：${status.title}\n会话 ID：\`${status.sessionId}\``
              : "该线程还没有关联的 Agent 会话。发一条消息即可创建。",
          );
          return;
        }
        case "new": {
          const { sessionId } = await this.ingress.resetThreadSession(
            tenantId,
            binding.id,
            input.threadKey,
            input.userKey,
            `${binding.platform} 远程会话`,
          );
          this.sessions.bind(sessionId, {
            chat: bot,
            threadId: input.threadKey,
            channelId: input.threadKey,
            platform: binding.platform,
            bindingId: binding.id,
          });
          await reply(input, `已开启新会话。\n会话 ID：\`${sessionId}\``);
          return;
        }
        case "stop": {
          const result = await this.ingress.stopThreadRun(
            tenantId,
            binding.id,
            input.threadKey,
          );
          await reply(
            input,
            result.stopped ? "已停止当前回复。" : "当前没有进行中的回复。",
          );
          return;
        }
        default:
          await reply(input, `未知指令：/${name}\n\n${formatHelp(allowed)}`);
      }
    };

    const handleMessage = async (thread: any, message: any) => {
      const text = String(message?.text ?? "").trim();
      const userKey = authorKey(message);
      const email = senderEmail(message);
      const displayName = String(
        message?.author?.fullName ?? message?.author?.userName ?? "",
      ).trim() || undefined;

      // 无原生 slash 路由的平台：把以 / 开头的文本当指令
      const parsed = parseSlashFromText(text);
      if (parsed && REMOTE_SLASH_NAMES.includes(parsed.command)) {
        await handleSlash({
          post: (msg) => thread.post(msg),
          threadKey: String(thread.id),
          command: parsed.command,
          args: parsed.args,
          userKey,
          email,
          displayName,
        });
        return;
      }

      if (!(await this.ingress.isAllowed(tenantId, binding.id, userKey, email))) {
        await thread.post(accessDeniedHint(userKey));
        return;
      }

      // Memoh 式入站确认：👀 + typing（平台不支持则静默跳过）
      await acknowledgeInboundMessage(thread, message);

      const input: RemoteInboundMessage = {
        tenantId,
        bindingId: binding.id,
        platform: binding.platform,
        externalEventId: String(message?.id ?? `${thread.id}:${Date.now()}`),
        externalThreadKey: String(thread.id),
        externalUserKey: userKey,
        senderEmail: email,
        text,
        title: `${binding.platform} 远程会话`,
        onSessionReady: (sessionId) => {
          this.sessions.bind(sessionId, {
            chat: bot,
            threadId: String(thread.id),
            channelId: String(thread.channelId ?? thread.channel?.id ?? thread.id),
            platform: binding.platform,
            bindingId: binding.id,
          });
        },
      };
      try {
        const result = await this.ingress.handleInbound(input);
        if (!result.accepted || result.duplicate || !("runId" in result)) return;
        await deliverRunToThread(thread, this.store, result.sessionId, result.runId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordPlatformFault("remote_agent.inbound", error, { subsystem: "remote_agent" });
        await thread.post(`Agent 暂时无法处理消息：${reason}`);
      }
    };

    bot.onDirectMessage(handleMessage);
    bot.onNewMention(handleMessage);
    bot.onSubscribedMessage(handleMessage);
    bot.onSlashCommand(async (event) => {
      const user = event?.user ?? {};
      const channel = event?.channel;
      if (!channel?.post) return;
      await handleSlash({
        post: (msg) => channel.post(msg),
        threadKey: String(event.channelId ?? channel.id ?? ""),
        command: String(event.command ?? ""),
        args: String(event.text ?? "").trim(),
        userKey: String(user.userId ?? user.id ?? user.userName ?? "unknown"),
        email:
          typeof user.email === "string" && user.email.trim() ? user.email.trim() : undefined,
        displayName: String(user.fullName ?? user.userName ?? "").trim() || undefined,
      });
    });

    await bot.initialize();

    void registerPlatformSlashCommands(binding.platform, adapterConfig)
      .then((result) => {
        if (result.skipped) return;
        platformEvents.publish(tenantId, {
          type: "connector_notice",
          agentId: binding.agentId ?? "",
          bindingId: binding.id,
          platform: binding.platform,
          level: result.ok ? "ok" : "error",
          message: result.detail,
        });
      })
      .catch((error) => {
        recordPlatformFault("remote_agent.slash_menu", error, {
          subsystem: "remote_agent",
        });
        platformEvents.publish(tenantId, {
          type: "connector_notice",
          agentId: binding.agentId ?? "",
          bindingId: binding.id,
          platform: binding.platform,
          level: "error",
          message: "斜杠指令注册失败",
        });
      });

    this.bots.set(binding.id, bot);
    return bot;
  }
}
