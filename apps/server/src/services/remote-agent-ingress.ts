import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "@zakura/core";
import type { CloudAgentSessionOrigin } from "@zakura/shared";
import { parseCloudAgentConfig } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agentChannelBindings,
  agentChannelEvents,
  agentChannelThreads,
  newId,
  type AgentChannelBinding,
} from "../db/schema.js";
import type { AgentService } from "./agents.js";
import type { CloudAgentRuntime } from "./cloud-agent-runtime.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";
import { platformEvents } from "./platform-events.js";

function readBindingConfig(secret: string, configEnc: string | null | undefined): Record<string, unknown> {
  if (!configEnc?.trim()) return {};
  try {
    return decryptJson<Record<string, unknown>>(secret, configEnc);
  } catch {
    return {};
  }
}

function configuredFieldsOf(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter(
    (key) => values[key] != null && String(values[key]).trim() !== "",
  );
}

export type PendingRemoteUser = {
  userKey: string;
  email?: string;
  displayName?: string;
  requestedAt: string;
  threadKey?: string;
};

export type RemoteChannelSettings = {
  /**
   * 是否允许所有人。默认 false（需白名单审批）。
   * 空白名单且 allowAll≠true → 拒绝。
   */
  allowAll?: boolean;
  allowedUsers?: string[];
  allowedEmails?: string[];
  pendingUsers?: PendingRemoteUser[];
  allowGroups?: boolean;
  allowDMs?: boolean;
  /** 连接器级模型覆盖；空则沿用 Agent cloud / 租户默认 */
  model?: string;
  modelRouteId?: string | null;
};

export type RemoteInboundMessage = {
  tenantId: string;
  bindingId: string;
  platform: string;
  externalEventId: string;
  externalThreadKey: string;
  externalUserKey: string;
  senderEmail?: string;
  text: string;
  title?: string;
  onSessionReady?: (sessionId: string, threadKey: string) => void;
};

export type RemoteInboundResult =
  | { accepted: true; duplicate: false; sessionId: string; runId: string }
  | { accepted: true; duplicate: true; sessionId: string }
  | { accepted: false; reason: "disabled" | "forbidden" | "invalid" };

function parseSettings(raw: string): RemoteChannelSettings {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as RemoteChannelSettings;
  } catch {
    return {};
  }
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return typeof value === "string"
    ? value
        .split(/[\s,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function matchesRule(value: string, rule: string): boolean {
  const normalized = value.trim().toLowerCase();
  const candidate = rule.trim().toLowerCase();
  if (!normalized || !candidate) return false;
  if (candidate === "*") return true;
  if (candidate.startsWith("*@")) return normalized.endsWith(candidate.slice(1));
  if (candidate.startsWith("@")) return normalized.endsWith(candidate);
  return normalized === candidate;
}

export function isRemoteSenderAllowed(
  settings: RemoteChannelSettings,
  externalUserKey: string,
  senderEmail?: string,
): boolean {
  const rules = [...values(settings.allowedUsers), ...values(settings.allowedEmails)];
  if (rules.length === 0) return settings.allowAll === true;
  return rules.some(
    (rule) => matchesRule(externalUserKey, rule) || (senderEmail ? matchesRule(senderEmail, rule) : false),
  );
}

function originOf(input: RemoteInboundMessage): CloudAgentSessionOrigin {
  return {
    source: "remote",
    platform: input.platform,
    connectionId: input.bindingId,
    externalThreadKey: input.externalThreadKey,
    externalUserKey: input.externalUserKey,
  };
}

async function resolveSessionModel(
  agentService: AgentService,
  tenantId: string,
  agentId: string,
  settings: RemoteChannelSettings,
): Promise<{ model: string | null; modelRouteId: string | null }> {
  const bindingModel = settings.model?.trim() || "";
  if (bindingModel) {
    return {
      model: bindingModel,
      modelRouteId: settings.modelRouteId?.trim() || null,
    };
  }
  const agent = await agentService.get(tenantId, agentId);
  if (!agent) return { model: null, modelRouteId: null };
  try {
    const cloud = parseCloudAgentConfig(JSON.parse(agent.configJson || "{}"));
    return {
      model: cloud.model?.trim() || null,
      modelRouteId: cloud.modelRouteId?.trim() || null,
    };
  } catch {
    return { model: null, modelRouteId: null };
  }
}

export type RemoteBindingCredentials = {
  enabled: boolean;
  values: Record<string, unknown>;
  configuredFields: string[];
};

export type RemoteBindingView = {
  id: string;
  agentId: string;
  platform: string;
  profileKey: string;
  label: string;
  enabled: boolean;
  settings: RemoteChannelSettings;
  credentialsEnabled: boolean;
  configuredFields: string[];
  createdAt: string;
  updatedAt: string;
};

export class RemoteAgentIngress {
  constructor(
    private readonly db: Db,
    private readonly agentService: AgentService,
    private readonly store: CloudAgentSessionStore,
    private readonly runtime: Pick<CloudAgentRuntime, "startTurn">,
    private readonly appConfig: AppConfig,
  ) {}

  async listBindings(tenantId: string, platform?: string) {
    return this.db
      .select()
      .from(agentChannelBindings)
      .where(
        and(
          eq(agentChannelBindings.tenantId, tenantId),
          ...(platform ? [eq(agentChannelBindings.platform, platform)] : []),
        ),
      );
  }

  async getBinding(tenantId: string, bindingId: string) {
    const [binding] = await this.db
      .select()
      .from(agentChannelBindings)
      .where(and(eq(agentChannelBindings.tenantId, tenantId), eq(agentChannelBindings.id, bindingId)))
      .limit(1);
    return binding ?? null;
  }

  /** Decrypted per-instance credentials (empty if not yet configured on this binding). */
  getBindingCredentials(binding: AgentChannelBinding): RemoteBindingCredentials {
    const values = readBindingConfig(this.appConfig.secret, binding.configEnc);
    const { __credentialsEnabled: flag, ...rest } = values;
    const configuredFields = configuredFieldsOf(rest);
    const enabled =
      flag === undefined
        ? configuredFields.length > 0
        : flag === true || String(flag).toLowerCase() === "true";
    return {
      enabled,
      values: rest,
      configuredFields,
    };
  }

  async mergeBindingCredentials(
    tenantId: string,
    bindingId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const binding = await this.getBinding(tenantId, bindingId);
    if (!binding) throw new Error("远程连接不存在");
    const current = this.getBindingCredentials(binding);
    const next = { ...current.values, ...patch, __credentialsEnabled: current.enabled };
    await this.db
      .update(agentChannelBindings)
      .set({
        configEnc: encryptJson(this.appConfig.secret, next),
        updatedAt: new Date(),
      })
      .where(eq(agentChannelBindings.id, binding.id));
  }

  toBindingView(binding: AgentChannelBinding | null): RemoteBindingView | null {
    if (!binding) return null;
    const credentials = this.getBindingCredentials(binding);
    return {
      id: binding.id,
      agentId: binding.agentId,
      platform: binding.platform,
      profileKey: binding.profileKey,
      label: binding.label,
      enabled: binding.enabled,
      settings: parseSettings(binding.settingsJson),
      credentialsEnabled: credentials.enabled,
      configuredFields: credentials.configuredFields,
      createdAt: binding.createdAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString(),
    };
  }

  async ensureBinding(
    tenantId: string,
    input: {
      agentId: string;
      platform: string;
      profileKey: string;
      label?: string;
      settings?: RemoteChannelSettings;
    },
  ) {
    const [existing] = await this.db
      .select()
      .from(agentChannelBindings)
      .where(
        and(
          eq(agentChannelBindings.tenantId, tenantId),
          eq(agentChannelBindings.platform, input.platform),
          eq(agentChannelBindings.profileKey, input.profileKey),
        ),
      )
      .limit(1);
    const mergedSettings = {
      ...(existing ? parseSettings(existing.settingsJson) : {}),
      ...(input.settings ?? {}),
    };
    return this.saveBinding(tenantId, {
      ...input,
      settings: mergedSettings,
      ...(existing ? { id: existing.id } : {}),
      enabled: true,
    });
  }

  async saveBinding(
    tenantId: string,
    input: {
      id?: string;
      agentId: string;
      platform: string;
      profileKey: string;
      label?: string;
      enabled?: boolean;
      settings?: RemoteChannelSettings;
      /** Per-instance credential field values; secrets may be "***" to keep existing. */
      credentials?: Record<string, unknown>;
      credentialsEnabled?: boolean;
    },
  ) {
    const agent = await this.agentService.get(tenantId, input.agentId);
    if (!agent) throw new Error("Agent 不存在");
    const now = new Date();
    const settings: RemoteChannelSettings = {
      allowAll: false,
      ...(input.settings ?? {}),
    };
    const settingsJson = JSON.stringify(settings);
    if (input.id) {
      const existing = await this.getBinding(tenantId, input.id);
      if (!existing) throw new Error("远程连接不存在");
      const configEnc =
        input.credentials !== undefined || input.credentialsEnabled !== undefined
          ? this.buildConfigEnc(existing, input.credentials, input.credentialsEnabled)
          : existing.configEnc;
      const platform = input.platform.trim();
      // Chat SDK instances keep a unique key; email inbound keeps connector profile keys.
      const profileKey =
        platform === "email"
          ? input.profileKey.trim() || existing.profileKey
          : existing.profileKey.includes(":")
            ? existing.profileKey
            : `remote-${platform}:${existing.id}`;
      const [updated] = await this.db
        .update(agentChannelBindings)
        .set({
          agentId: input.agentId,
          platform,
          profileKey,
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          settingsJson,
          configEnc,
          updatedAt: now,
        })
        .where(eq(agentChannelBindings.id, existing.id))
        .returning();
      return updated;
    }
    const id = newId();
    const platform = input.platform.trim();
    // Chat SDK: unique per instance. Email inbound: keep connector profile key for ensureBinding.
    const profileKey =
      platform === "email"
        ? input.profileKey.trim() || `email:${id}`
        : `remote-${platform}:${id}`;
    const configEnc = this.buildConfigEnc(null, input.credentials, input.credentialsEnabled);
    const [created] = await this.db
      .insert(agentChannelBindings)
      .values({
        id,
        tenantId,
        agentId: input.agentId,
        platform,
        profileKey,
        label: input.label?.trim() || `${platform} Agent`,
        enabled: input.enabled ?? false,
        settingsJson,
        configEnc,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  }

  private buildConfigEnc(
    existing: AgentChannelBinding | null,
    credentials: Record<string, unknown> | undefined,
    credentialsEnabled: boolean | undefined,
  ): string {
    const current = existing ? this.getBindingCredentials(existing) : { enabled: false, values: {}, configuredFields: [] };
    const next: Record<string, unknown> = { ...current.values };
    for (const [key, value] of Object.entries(credentials ?? {})) {
      if (value === "***" || value === undefined) continue;
      if (value === "") {
        delete next[key];
        continue;
      }
      next[key] = value;
    }
    const enabled =
      credentialsEnabled !== undefined
        ? credentialsEnabled
        : current.enabled || configuredFieldsOf(next).length > 0;
    return encryptJson(this.appConfig.secret, {
      ...next,
      __credentialsEnabled: enabled,
    });
  }

  async deleteBinding(tenantId: string, bindingId: string): Promise<boolean> {
    const existing = await this.getBinding(tenantId, bindingId);
    if (!existing) return false;
    await this.db
      .delete(agentChannelBindings)
      .where(and(eq(agentChannelBindings.tenantId, tenantId), eq(agentChannelBindings.id, bindingId)));
    return true;
  }

  async getThreadStatus(tenantId: string, bindingId: string, externalThreadKey: string) {
    const binding = await this.getBinding(tenantId, bindingId);
    if (!binding) return null;
    const [thread] = await this.db
      .select()
      .from(agentChannelThreads)
      .where(
        and(
          eq(agentChannelThreads.bindingId, bindingId),
          eq(agentChannelThreads.externalThreadKey, externalThreadKey),
        ),
      )
      .limit(1);
    if (!thread) return null;
    const session = await this.store.getSession(tenantId, binding.agentId, thread.sessionId);
    if (!session) return null;
    return {
      sessionId: session.id,
      title: session.title,
      status: session.status,
      activeRunId: session.activeRunId,
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  async isAllowed(
    tenantId: string,
    bindingId: string,
    externalUserKey: string,
    senderEmail?: string,
  ): Promise<boolean> {
    const binding = await this.getBinding(tenantId, bindingId);
    return Boolean(
      binding &&
        binding.enabled &&
        isRemoteSenderAllowed(parseSettings(binding.settingsJson), externalUserKey, senderEmail),
    );
  }

  async getSettings(tenantId: string, bindingId: string): Promise<RemoteChannelSettings | null> {
    const binding = await this.getBinding(tenantId, bindingId);
    return binding ? parseSettings(binding.settingsJson) : null;
  }

  private async patchSettings(
    tenantId: string,
    bindingId: string,
    patch: (current: RemoteChannelSettings) => RemoteChannelSettings,
  ): Promise<RemoteChannelSettings> {
    const binding = await this.getBinding(tenantId, bindingId);
    if (!binding) throw new Error("远程连接不存在");
    const next = patch(parseSettings(binding.settingsJson));
    await this.db
      .update(agentChannelBindings)
      .set({ settingsJson: JSON.stringify(next), updatedAt: new Date() })
      .where(eq(agentChannelBindings.id, binding.id));
    return next;
  }

  /** 用户申请访问；已批准则直接提示，重复申请幂等。 */
  async requestAccess(
    tenantId: string,
    bindingId: string,
    input: {
      userKey: string;
      email?: string;
      displayName?: string;
      threadKey?: string;
    },
  ): Promise<{ status: "allowed" | "pending" | "queued"; pending: PendingRemoteUser[] }> {
    const settings = await this.getSettings(tenantId, bindingId);
    if (!settings) throw new Error("远程连接不存在");
    if (isRemoteSenderAllowed(settings, input.userKey, input.email)) {
      return { status: "allowed", pending: settings.pendingUsers ?? [] };
    }
    const key = input.userKey.trim();
    const existing = (settings.pendingUsers ?? []).find(
      (p) => p.userKey.trim().toLowerCase() === key.toLowerCase(),
    );
    if (existing) return { status: "pending", pending: settings.pendingUsers ?? [] };
    const entry: PendingRemoteUser = {
      userKey: key,
      ...(input.email ? { email: input.email } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.threadKey ? { threadKey: input.threadKey } : {}),
      requestedAt: new Date().toISOString(),
    };
    const next = await this.patchSettings(tenantId, bindingId, (current) => ({
      ...current,
      pendingUsers: [...(current.pendingUsers ?? []), entry],
    }));
    return { status: "queued", pending: next.pendingUsers ?? [] };
  }

  async approveUser(
    tenantId: string,
    bindingId: string,
    userKey: string,
  ): Promise<{ ok: boolean; settings: RemoteChannelSettings }> {
    const key = userKey.trim();
    if (!key) throw new Error("userKey 必填");
    const settings = await this.patchSettings(tenantId, bindingId, (current) => {
      const allowedUsers = values(current.allowedUsers);
      if (!allowedUsers.some((u) => u.toLowerCase() === key.toLowerCase())) {
        allowedUsers.push(key);
      }
      return {
        ...current,
        allowedUsers,
        pendingUsers: (current.pendingUsers ?? []).filter(
          (p) => p.userKey.trim().toLowerCase() !== key.toLowerCase(),
        ),
      };
    });
    return { ok: true, settings };
  }

  async denyUser(
    tenantId: string,
    bindingId: string,
    userKey: string,
  ): Promise<{ ok: boolean; settings: RemoteChannelSettings }> {
    const key = userKey.trim().toLowerCase();
    const settings = await this.patchSettings(tenantId, bindingId, (current) => ({
      ...current,
      pendingUsers: (current.pendingUsers ?? []).filter(
        (p) => p.userKey.trim().toLowerCase() !== key,
      ),
      allowedUsers: values(current.allowedUsers).filter((u) => u.toLowerCase() !== key),
    }));
    return { ok: true, settings };
  }

  /** 打断当前 Run 并换新会话（/new） */
  async resetThreadSession(
    tenantId: string,
    bindingId: string,
    externalThreadKey: string,
    externalUserKey: string,
    title?: string,
  ): Promise<{ sessionId: string }> {
    const binding = await this.getBinding(tenantId, bindingId);
    if (!binding) throw new Error("远程连接不存在");
    const [thread] = await this.db
      .select()
      .from(agentChannelThreads)
      .where(
        and(
          eq(agentChannelThreads.bindingId, bindingId),
          eq(agentChannelThreads.externalThreadKey, externalThreadKey),
        ),
      )
      .limit(1);
    if (thread) {
      await this.interruptActiveRun(tenantId, binding.agentId, thread.sessionId);
      await this.db.delete(agentChannelThreads).where(eq(agentChannelThreads.id, thread.id));
    }
    const settings = parseSettings(binding.settingsJson);
    const modelPrefs = await resolveSessionModel(
      this.agentService,
      tenantId,
      binding.agentId,
      settings,
    );
    const session = await this.store.createSession({
      tenantId,
      agentId: binding.agentId,
      title: title || `${binding.platform} 远程会话`,
      kind: "system",
      origin: {
        source: "remote",
        platform: binding.platform,
        connectionId: binding.id,
        externalThreadKey,
        externalUserKey,
      },
      model: modelPrefs.model,
      modelRouteId: modelPrefs.modelRouteId,
    });
    await this.db.insert(agentChannelThreads).values({
      id: newId(),
      tenantId,
      bindingId: binding.id,
      sessionId: session.id,
      externalThreadKey,
      externalUserKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { sessionId: session.id };
  }

  /** 停止当前 Run（/stop） */
  async stopThreadRun(
    tenantId: string,
    bindingId: string,
    externalThreadKey: string,
  ): Promise<{ stopped: boolean; sessionId?: string }> {
    const binding = await this.getBinding(tenantId, bindingId);
    if (!binding) throw new Error("远程连接不存在");
    const [thread] = await this.db
      .select()
      .from(agentChannelThreads)
      .where(
        and(
          eq(agentChannelThreads.bindingId, bindingId),
          eq(agentChannelThreads.externalThreadKey, externalThreadKey),
        ),
      )
      .limit(1);
    if (!thread) return { stopped: false };
    const session = await this.store.getSession(tenantId, binding.agentId, thread.sessionId);
    if (!session?.activeRunId) return { stopped: false, sessionId: thread.sessionId };
    await this.interruptActiveRun(tenantId, binding.agentId, thread.sessionId);
    return { stopped: true, sessionId: thread.sessionId };
  }

  async handleInbound(input: RemoteInboundMessage): Promise<RemoteInboundResult> {
    const binding = await this.getBinding(input.tenantId, input.bindingId);
    if (!binding || binding.platform !== input.platform || !binding.enabled) {
      return { accepted: false, reason: "disabled" };
    }
    if (
      !input.text.trim() ||
      !isRemoteSenderAllowed(parseSettings(binding.settingsJson), input.externalUserKey, input.senderEmail)
    ) {
      return { accepted: false, reason: "forbidden" };
    }

    const [seen] = await this.db
      .select({ id: agentChannelEvents.id })
      .from(agentChannelEvents)
      .where(
        and(
          eq(agentChannelEvents.bindingId, binding.id),
          eq(agentChannelEvents.externalEventId, input.externalEventId),
        ),
      )
      .limit(1);
    if (seen) {
      const [thread] = await this.db
        .select()
        .from(agentChannelThreads)
        .where(
          and(
            eq(agentChannelThreads.bindingId, binding.id),
            eq(agentChannelThreads.externalThreadKey, input.externalThreadKey),
          ),
        )
        .limit(1);
      const settings = parseSettings(binding.settingsJson);
      if (
        thread &&
        settings.allowGroups !== true &&
        input.externalUserKey !== thread.externalUserKey
      ) {
        return { accepted: false, reason: "forbidden" };
      }
      return thread
        ? { accepted: true, duplicate: true, sessionId: thread.sessionId }
        : { accepted: false, reason: "invalid" };
    }

    let [thread] = await this.db
      .select()
      .from(agentChannelThreads)
      .where(
        and(
          eq(agentChannelThreads.bindingId, binding.id),
          eq(agentChannelThreads.externalThreadKey, input.externalThreadKey),
        ),
      )
      .limit(1);

    if (!thread) {
      const settings = parseSettings(binding.settingsJson);
      const modelPrefs = await resolveSessionModel(
        this.agentService,
        input.tenantId,
        binding.agentId,
        settings,
      );
      const session = await this.store.createSession({
        tenantId: input.tenantId,
        agentId: binding.agentId,
        title: input.title || `${input.platform} 远程会话`,
        kind: "system",
        origin: originOf(input),
        model: modelPrefs.model,
        modelRouteId: modelPrefs.modelRouteId,
      });
      try {
        const [created] = await this.db
          .insert(agentChannelThreads)
          .values({
            id: newId(),
            tenantId: input.tenantId,
            bindingId: binding.id,
            sessionId: session.id,
            externalThreadKey: input.externalThreadKey,
            externalUserKey: input.externalUserKey,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();
        thread = created;
      } catch {
        const [existing] = await this.db
          .select()
          .from(agentChannelThreads)
          .where(
            and(
              eq(agentChannelThreads.bindingId, binding.id),
              eq(agentChannelThreads.externalThreadKey, input.externalThreadKey),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("创建远程线程映射失败");
        await this.store.deleteSession(input.tenantId, binding.agentId, session.id);
        thread = existing;
      }
    }
    if (
      thread.externalUserKey &&
      thread.externalUserKey !== input.externalUserKey &&
      parseSettings(binding.settingsJson).allowGroups !== true
    ) {
      return { accepted: false, reason: "forbidden" };
    }

    const [event] = await this.db
      .insert(agentChannelEvents)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        bindingId: binding.id,
        externalEventId: input.externalEventId,
        receivedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [agentChannelEvents.bindingId, agentChannelEvents.externalEventId],
      })
      .returning();
    if (!event) return { accepted: true, duplicate: true, sessionId: thread.sessionId };

    input.onSessionReady?.(thread.sessionId, input.externalThreadKey);
    try {
      const { runId } = await this.startTurnAllowInterrupt(
        input.tenantId,
        binding.agentId,
        thread.sessionId,
        input.text,
      );
      await this.db
        .update(agentChannelThreads)
        .set({
          lastEventId: input.externalEventId,
          lastEventAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentChannelThreads.id, thread.id));
      platformEvents.publish(input.tenantId, {
        type: "connector_inbound",
        agentId: binding.agentId,
        sessionId: thread.sessionId,
        platform: input.platform,
        title: (input.title || `${input.platform} 新消息`).slice(0, 80),
        preview: input.text.trim().slice(0, 160) || undefined,
      });
      return { accepted: true, duplicate: false, sessionId: thread.sessionId, runId };
    } catch (error) {
      await this.db.delete(agentChannelEvents).where(eq(agentChannelEvents.id, event.id));
      throw error;
    }
  }

  /** 取消进行中的 Run 并等待会话锁释放，允许新消息打断。 */
  private async interruptActiveRun(
    tenantId: string,
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.store.getSession(tenantId, agentId, sessionId);
    const runId = session?.activeRunId;
    if (!runId) return;

    await this.store.requestCancel(sessionId, runId);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await this.store.getSession(tenantId, agentId, sessionId);
      if (!current?.activeRunId || current.activeRunId !== runId) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    const still = await this.store.getRun(runId);
    if (still && (still.status === "queued" || still.status === "running")) {
      try {
        await this.store.appendEvent({
          sessionId,
          type: "run_end",
          runId,
          payload: { runId, status: "cancelled" },
        });
      } catch {
        // 事件写入失败仍要释放锁
      }
      await this.store.finishRun(sessionId, runId, "cancelled");
    }
  }

  private async startTurnAllowInterrupt(
    tenantId: string,
    agentId: string,
    sessionId: string,
    content: string,
  ): Promise<{ runId: string }> {
    await this.interruptActiveRun(tenantId, agentId, sessionId);
    try {
      return await this.runtime.startTurn({ tenantId, agentId, sessionId, content });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("已有进行中的 Run")) {
        throw error;
      }
      // 并发入站：再打断一次后重试
      await this.interruptActiveRun(tenantId, agentId, sessionId);
      return this.runtime.startTurn({ tenantId, agentId, sessionId, content });
    }
  }
}
