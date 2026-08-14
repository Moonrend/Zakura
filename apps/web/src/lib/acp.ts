import type {
  AcpAgentConfig,
  AcpPublicProfile,
  AcpRuntimeStatus,
} from "@zakura/shared";
import { api } from "@/lib/api";

export type AcpConfigResponse = {
  config: AcpAgentConfig;
  profiles: AcpPublicProfile[];
};

export async function fetchAcpConfig(agentId: string) {
  return api<AcpConfigResponse>(`/api/agents/${agentId}/acp/config`, { cacheTtlMs: false });
}

export async function saveAcpConfig(agentId: string, config: AcpAgentConfig) {
  return api<AcpConfigResponse>(`/api/agents/${agentId}/acp/config`, {
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

export async function startAcpDeviceLogin(agentId: string, profileId: string) {
  return api<{
    loginId: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    expiresIn: number;
    status: string;
    error?: string;
  }>(`/api/agents/${agentId}/acp/agents/${encodeURIComponent(profileId)}/oauth/device/start`, {
    method: "POST",
  });
}

export async function pollAcpDeviceLogin(agentId: string, profileId: string, loginId: string) {
  return api<{
    loginId: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    expiresIn: number;
    status: string;
    error?: string;
  }>(`/api/agents/${agentId}/acp/agents/${encodeURIComponent(profileId)}/oauth/device/poll`, {
    method: "POST",
    json: { loginId },
  });
}

export async function cancelAcpDeviceLogin(agentId: string, profileId: string, loginId: string) {
  return api(`/api/agents/${agentId}/acp/agents/${encodeURIComponent(profileId)}/oauth/device/cancel`, {
    method: "POST",
    json: { loginId },
  });
}

export async function authenticateAcpSession(agentId: string, sessionId: string, methodId: string) {
  return api<AcpRuntimeStatus>(`/api/agents/${agentId}/sessions/${sessionId}/acp/authenticate`, {
    method: "POST",
    json: { methodId },
  });
}

export async function logoutAcpSession(agentId: string, sessionId: string) {
  return api(`/api/agents/${agentId}/sessions/${sessionId}/acp/logout`, { method: "POST" });
}

export type AcpTerminalSnapshot = {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command?: string;
};

export function startAcpWorkspaceTerminal(agentId: string, profileId?: string) {
  return api<AcpTerminalSnapshot>(`/api/agents/${agentId}/acp/workspace/terminal`, {
    method: "POST",
    json: profileId ? { profileId } : {},
  });
}

export function fetchAcpWorkspaceTerminal(agentId: string, jobId: string) {
  return api<AcpTerminalSnapshot>(
    `/api/agents/${agentId}/acp/workspace/terminal/${encodeURIComponent(jobId)}`,
    { cacheTtlMs: false },
  );
}

export function writeAcpWorkspaceTerminal(agentId: string, jobId: string, input: string) {
  return api<AcpTerminalSnapshot>(
    `/api/agents/${agentId}/acp/workspace/terminal/${encodeURIComponent(jobId)}/input`,
    { method: "POST", json: { input } },
  );
}

export function closeAcpWorkspaceTerminal(agentId: string, jobId: string) {
  return api<AcpTerminalSnapshot>(
    `/api/agents/${agentId}/acp/workspace/terminal/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}
