"use client";
import { api } from "@/lib/api";
import type { Run } from "@/lib/project-execution";
export type RenameRequest = {
  snapshotId: string;
  path: string;
  offset?: number;
  symbolId?: string;
  newName: string;
};
export type RenameEdit = {
  start: number;
  end: number;
  oldText: string;
  newText: string;
};
export type RenameFile = {
  path: string;
  beforeHash: string;
  afterHash: string;
  edits: RenameEdit[];
};
export type RenamePreview = {
  id: string;
  version: string;
  snapshotId: string;
  request: RenameRequest;
  selection: {
    name: string;
    kind: string;
    path: string;
    offset: number;
    package: string;
    exported: boolean;
  };
  newName: string;
  files: RenameFile[];
  references: number;
  checkedPackages: string[];
  exportedApiChanged: boolean;
  requiresHumanReview: boolean;
  warnings: string[];
};
export type RenameCandidate = {
  id: string;
  previewId: string;
  branchId: string;
  snapshotId: string;
  baseSnapshot: string;
  files: RenameFile[];
  exportedApiChanged: boolean;
  requiresHumanReview: boolean;
  acceptanceInherited: boolean;
};
const base = (pid: string) =>
  `/api/project-executions/${encodeURIComponent(pid)}/refactors`;
export const previewRename = (pid: string, request: RenameRequest) =>
  api<RenamePreview>(`${base(pid)}/preview`, { method: "POST", json: request });
export const createRenameBranch = (pid: string, preview: RenamePreview) =>
  api<RenameCandidate>(`${base(pid)}/apply`, {
    method: "POST",
    json: {
      ...preview.request,
      previewId: preview.id,
      confirmation: "create_branch",
    },
  });
export const inspectRenameCandidate = (pid: string, id: string) =>
  api<RenameCandidate>(`${base(pid)}/${encodeURIComponent(id)}`, {
    cacheTtlMs: false,
  });
export const runRenameCandidate = (
  pid: string,
  id: string,
  expectedRevision: number,
) =>
  api<Run>(`${base(pid)}/${encodeURIComponent(id)}/runs`, {
    method: "POST",
    json: { expectedRevision },
  });
