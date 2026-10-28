"use client";

import { api, ApiError } from "./api";
import type {
  WorkflowRequest,
  WorkflowResult,
  WorkflowTemplate,
  WorkflowValidation,
} from "@zakura/shared";

export const fetchWorkflowTemplates = (signal?: AbortSignal) =>
  api<WorkflowTemplate[]>("/api/workflows/templates", {
    signal,
    cacheTtlMs: false,
  });

export const validateWorkflow = (
  request: WorkflowRequest,
  signal?: AbortSignal,
) =>
  api<WorkflowValidation>("/api/workflows/validate", {
    method: "POST",
    json: request,
    signal,
  });

export async function planWorkflow(
  request: WorkflowRequest,
  signal?: AbortSignal,
): Promise<WorkflowResult> {
  try {
    return await api<WorkflowResult>("/api/workflows/plan", {
      method: "POST",
      json: request,
      signal,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 422 &&
      error.body.validation
    ) {
      return error.body as unknown as WorkflowResult;
    }
    throw error;
  }
}

export function downloadWorkflow(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Let the navigation resolve the Blob before revoking its URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
