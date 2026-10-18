import type {
  AcpAgentConfig,
  AcpPublicProfile,
  AcpRuntimeStatus,
} from "@zakura/shared";
import { api } from "@/lib/api";

export type AcpConfigResponse = {
  config: AcpAgentConfig;
  profiles: AcpPublicProfile[];
  /** configJson 解析失败时服务端透出的原因;保存一次即可修复为合法 JSON */
  configError?: string;
};

export type AcpSettingsTarget = string | { spaceId: string };

function acpSettingsPath(target: AcpSettingsTarget): string {
  return typeof target === "string"
    ? `/api/agents/${target}/acp`
    : `/api/spaces/${target.spaceId}/acp`;
}

export async function fetchAcpConfig(agentId: AcpSettingsTarget) {
  return api<AcpConfigResponse>(`${acpSettingsPath(agentId)}/config`, { cacheTtlMs: false });
}

export async function saveAcpConfig(agentId: AcpSettingsTarget, config: AcpAgentConfig) {
  return api<AcpConfigResponse>(`${acpSettingsPath(agentId)}/config`, {
    method: "PUT",
    json: config,
  });
}

export async function setAcpMode(agentId: string, sessionId: string, modeId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${agentId}/sessions/${sessionId}/acp-runtime/mode`, {
    method: "PATCH",
    json: { modeId },
  });
}

export async function setAcpModel(agentId: string, sessionId: string, modelId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${agentId}/sessions/${sessionId}/acp-runtime/model`, {
    method: "PATCH",
    json: { modelId },
  });
}

export async function setAcpConfigOption(
  agentId: string,
  sessionId: string,
  configId: string,
  value: string | boolean,
) {
  return api<AcpRuntimeStatus>(`/api/agents/${agentId}/sessions/${sessionId}/acp-runtime/config`, {
    method: "PATCH",
    json: { configId, value },
  });
}

export async function fetchAcpRuntime(agentId: string, sessionId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${agentId}/sessions/${sessionId}/acp-runtime`, {
    cacheTtlMs: false,
  });
}

export async function reconnectAcpRuntime(agentId: string, sessionId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/acp-runtime/reconnect`, {
    method: "POST",
  });
}

export async function closeAcpRuntime(agentId: string, sessionId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/acp-runtime/close`, {
    method: "POST",
  });
}

export async function prepareAcpDraft(agentId: string, profileId: string, project?: string | null) {
  return api<{
    session: import("./cloud-agent").CloudSession;
    runtime: AcpRuntimeStatus;
  }>(`/api/agents/${agentId}/acp/draft`, {
    method: "POST",
    json: { profileId, ...(project !== undefined ? { project } : {}) },
  });
}

export async function resolveAcpPermission(
  agentId: string,
  sessionId: string,
  body: { requestId: string; optionId?: string; cancelled?: boolean },
) {
  return api(`/api/agents/${agentId}/sessions/${sessionId}/acp/permission`, {
    method: "POST",
    json: body,
  });
}

export async function resolveAcpElicitation(
  agentId: string,
  sessionId: string,
  body: { requestId: string; cancelled?: boolean; content?: unknown },
) {
  return api(`/api/agents/${agentId}/sessions/${sessionId}/acp/elicitation`, {
    method: "POST",
    json: body,
  });
}

export type AcpDeviceAttempt = {
  attemptId: string;
  status: "pending" | "complete" | "cancelled" | "expired" | "failed" | "unknown";
  userCode?: string;
  verificationUri?: string;
  expiresAt: string;
  nextPollAt?: string;
  interval: number;
  error?: string;
};

export async function startAcpDeviceLogin(
  agentId: AcpSettingsTarget,
  profileId: string,
  signal?: AbortSignal,
): Promise<AcpDeviceAttempt> {
  const result = await api<{ device: AcpDeviceAttempt }>(
    `${acpSettingsPath(agentId)}/agents/${encodeURIComponent(profileId)}/oauth/device/start`,
    { method: "POST", signal },
  );
  return result.device;
}

export async function pollAcpDeviceLogin(
  agentId: AcpSettingsTarget,
  profileId: string,
  attemptId: string,
  signal?: AbortSignal,
): Promise<AcpDeviceAttempt> {
  const result = await api<{ device: AcpDeviceAttempt }>(
    `${acpSettingsPath(agentId)}/agents/${encodeURIComponent(profileId)}/oauth/device/poll`,
    { method: "POST", json: { attemptId }, signal },
  );
  return result.device;
}

export async function cancelAcpDeviceLogin(
  agentId: AcpSettingsTarget,
  profileId: string,
  attemptId: string,
  signal?: AbortSignal,
): Promise<{ cancelled: boolean }> {
  return api(`${acpSettingsPath(agentId)}/agents/${encodeURIComponent(profileId)}/oauth/device/cancel`, {
    method: "POST",
    json: { attemptId },
    signal,
  });
}

export type AcpAuthRecovery = {
  authentication: {
    kind: string;
    /** Authentication lease expiry, in Unix milliseconds. */
    expiresAt: number;
    nodeId: string;
    computerId: string;
  } | null;
  recoveryToken?: string;
};

export async function fetchAcpAuthRecovery(
  spaceId: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<AcpAuthRecovery> {
  return api(`/api/spaces/${encodeURIComponent(spaceId)}/acp/agents/${encodeURIComponent(profileId)}/auth-recovery`, {
    cacheTtlMs: false,
    signal,
  });
}

export async function acknowledgeAcpAuthRecovery(
  spaceId: string,
  profileId: string,
  recoveryToken: string,
  signal?: AbortSignal,
): Promise<{ reconciled: boolean }> {
  return api(`/api/spaces/${encodeURIComponent(spaceId)}/acp/agents/${encodeURIComponent(profileId)}/auth-recovery/acknowledge`, {
    method: "POST",
    json: { recoveryToken, operationQuiesced: true },
    signal,
  });
}

export async function probeAcpAdapter(
  agentId: AcpSettingsTarget,
  profileId: string,
): Promise<{ installed: boolean; command: string; output: string }> {
  return api(`${acpSettingsPath(agentId)}/agents/${encodeURIComponent(profileId)}/probe`, {
    method: "POST",
  });
}

export async function installAcpAdapter(
  agentId: AcpSettingsTarget,
  profileId: string,
  opts?: { version?: string; update?: boolean; rebuild?: boolean },
): Promise<{ ok: boolean; accepted: boolean; install: AcpAdapterInstallProgress }> {
  const params = new URLSearchParams();
  if (opts?.version) params.set("version", opts.version);
  if (opts?.update) params.set("update", "true");
  if (opts?.rebuild) params.set("rebuild", "true");
  const query = params.toString();
  return api(`${acpSettingsPath(agentId)}/agents/${encodeURIComponent(profileId)}/install${query ? `?${query}` : ""}`, {
    method: "POST",
  });
}

export type AcpAdapterInstallProgress = {
  profileId: string;
  registryId?: string;
  image?: string;
  state: "queued" | "pulling" | "completed" | "failed";
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
};

export async function fetchAcpAdapterInstalls(
  agentId: AcpSettingsTarget,
): Promise<AcpAdapterInstallProgress[]> {
  const result = await api<{ installs: AcpAdapterInstallProgress[] }>(
    `${acpSettingsPath(agentId)}/installs`,
    { cacheTtlMs: false },
  );
  return result.installs;
}

export type AcpAdapterStatus = {
  id: string;
  /** Profile id this adapter backs; differs from `id` for 12 of 42 agents. */
  profileId?: string;
  installed: string[];
  latest: string | null;
  updateAvailable: boolean;
  diskKb: Record<string, number>;
  /** Container adapters ship as prebuilt images and are never installed. */
  source: "workspace" | "container";
  image?: string;
  /**
   * Whether the image is actually present on the machine that runs it.
   * `undefined` means unknown (remote runner / probe failed) — never treat
   * unknown as ready.
   */
  imageReady?: boolean;
  /**
   * Registry version this agent explicitly adopted. Absent means the adapter
   * runs the version baked into this build's snapshot.
   */
  pinnedVersion?: string;
  /**
   * Set when update state could not be determined. Lets the UI say "check
   * failed" instead of falsely showing the adapter as up to date.
   */
  checkError?: string;
};

/**
 * Adopt a registry version for a container adapter, or roll back to the
 * snapshot version by passing null.
 */
export async function adoptAcpAdapterVersion(
  agentId: AcpSettingsTarget,
  registryId: string,
  version: string | null,
): Promise<{ id: string; pinnedVersion: string | null; image: string }> {
  return api(`${acpSettingsPath(agentId)}/adapters/${encodeURIComponent(registryId)}/adopt`, {
    method: "POST",
    json: { version: version ?? "" },
  });
}

export async function fetchAcpAdapterStatus(
  agentId: AcpSettingsTarget,
  opts?: { refresh?: boolean },
): Promise<AcpAdapterStatus[]> {
  const res = await api<{ adapters: AcpAdapterStatus[] }>(
    `${acpSettingsPath(agentId)}/adapters${opts?.refresh ? "?refresh=1" : ""}`,
  );
  return res.adapters;
}
