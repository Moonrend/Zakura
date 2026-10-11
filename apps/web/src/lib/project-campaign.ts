"use client";

import { api } from "./api";
import type { Budget, Project } from "./project-execution";
import type { Scalar } from "./project-workbench";

export type CampaignVariantSpec = {
  id: string;
  name: string;
  agentMapping: Record<string, string>;
  models?: Record<string, string>;
};
export type CampaignVariant = {
  id: string;
  name: string;
  project: Project;
  definitionHash: string;
  state: string;
  copyOperationId?: string;
  runId?: string;
  error?: string;
};
export type Campaign = {
  id: string;
  tenantId: string;
  spaceId: string;
  revision: number;
  status: string;
  definition: {
    name: string;
    sourceProjectId: string;
    templateId: string;
    templateVersion: number;
    baselineId: string;
    budget: Budget;
    reservedBudget: Budget;
    variants: CampaignVariant[];
  };
  baseSnapshot?: string;
  captureState: string;
  captureOperationId?: string;
  captureError?: string;
  controlAction?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type CampaignMeasurement = {
  variantId: string;
  name: string;
  projectId: string;
  runId?: string;
  status: string;
  terminal: boolean;
  chargedTokens: number;
  providerReportedTokens: number | null;
  modelCalls: number;
  toolCalls: number;
  elapsedSeconds: number;
  completedTasks: number;
  totalTasks: number;
  requiredChecksPassed: number;
  requiredChecksTotal: number;
  requiredChecksObserved: number;
  acceptanceRate: number | null;
  samples: number;
  unknown: string[];
  error?: string;
};
export type CampaignComparison = {
  baselineId: string;
  comparable: boolean;
  reasons: string[];
  differences: {
    variantId: string;
    taskId: string;
    field: string;
    baseline: string;
    candidate: string;
  }[];
  measurements: CampaignMeasurement[];
  reservedBudget: Budget;
  chargedTokens: number;
  modelCalls: number;
  toolCalls: number;
  observedAt: string;
};
export type CampaignAudit = {
  id: string;
  authorId: string;
  action: string;
  variantId?: string;
  comment: string;
  details: unknown;
  createdAt: string;
};
export type CampaignCreate = {
  name: string;
  sourceProjectId: string;
  templateId: string;
  templateVersion: number;
  expectedTemplateRevision: number;
  baselineId: string;
  budget: Budget;
  parameters: Record<string, Scalar>;
  variants: CampaignVariantSpec[];
};
export type CampaignResult = {
  campaign: Campaign;
  error?: string;
  results?: {
    variantId?: string;
    runId?: string;
    status: string;
    error?: string;
  }[];
};
const base = "/api/project-campaigns";
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
export const listCampaigns = (sourceProjectId: string) =>
  api<{ items: Campaign[] }>(
    `${base}/?sourceProjectId=${encodeURIComponent(sourceProjectId)}`,
    { cacheTtlMs: false },
  );
export const getCampaign = (id: string) =>
  api<{ campaign: Campaign; comparison: CampaignComparison }>(`${path(id)}/`, {
    cacheTtlMs: false,
  });
export const getCampaignAudit = (id: string) =>
  api<{ items: CampaignAudit[] }>(`${path(id)}/audit`, { cacheTtlMs: false });
function result(value: Campaign | CampaignResult): CampaignResult {
  return "campaign" in value ? value : { campaign: value };
}
export const createCampaign = async (body: CampaignCreate) =>
  result(
    await api<Campaign | CampaignResult>(`${base}/`, {
      method: "POST",
      json: body,
    }),
  );
export type CampaignAction = "provision" | "freeze" | "inspect";
export const campaignAction = async (
  current: Campaign,
  action: CampaignAction,
  comment: string,
) =>
  result(
    await api<Campaign | CampaignResult>(`${path(current.id)}/${action}`, {
      method: "POST",
      json: {
        expectedRevision: current.revision,
        comment,
        ...(action === "freeze" ? { confirmation: "freeze" } : {}),
      },
    }),
  );
export const campaignVariantAction = async (
  current: Campaign,
  variantId: string,
  action: "copy" | "start" | "retry-start",
  comment: string,
) =>
  result(
    await api<Campaign | CampaignResult>(
      `${path(current.id)}/variants/${encodeURIComponent(variantId)}/${action}`,
      {
        method: "POST",
        json: {
          expectedRevision: current.revision,
          comment,
          ...(action !== "copy" ? { confirmation: "start" } : {}),
        },
      },
    ),
  );
export const controlCampaign = async (
  current: Campaign,
  action: "pause" | "resume" | "cancel",
  comment: string,
) =>
  result(
    await api<CampaignResult>(`${path(current.id)}/control`, {
      method: "POST",
      json: { expectedRevision: current.revision, action, comment },
    }),
  );
