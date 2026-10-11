"use client";

import { api, ApiError, getSession } from "@/lib/api";
import type {
  MergePreview,
  Plan,
  Run,
  Verification,
} from "./project-execution";

export type DeliveryManifest = {
  schema: "zakura.project-delivery";
  version: 1;
  id: string;
  name: string;
  release: string;
  projectId: string;
  runId: string;
  snapshotId: string;
  goal: string;
  plan: Plan;
  checks: Verification[];
  review: {
    id: string;
    author: string;
    comment: string;
    previewId: string;
    previewRevision: number;
  };
  createdAt: string;
  payloadSha256: string;
  payloadBytes: number;
};
export type Delivery = {
  id: string;
  projectId: string;
  kind: "delivery" | "import";
  name: string;
  version: string;
  revision: number;
  status:
    | "preparing"
    | "unknown"
    | "ready"
    | "revoked"
    | "uploading"
    | "completed"
    | "aborted";
  operationId?: string;
  manifest?: DeliveryManifest;
  archive?: {
    id: string;
    snapshotId: string;
    manifestHash: string;
    sha256: string;
    bytes: number;
    chunkBytes: number;
    manifest: DeliveryManifest;
  };
  totalBytes?: number;
  received?: number;
  sha256?: string;
  snapshotId?: string;
  untrustedReview: boolean;
  createdBy: string;
  comment: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryChannel = {
  channel: string;
  deliveryId: string;
  revision: number;
  authorId: string;
  comment: string;
  updatedAt: string;
};
const root = (pid: string) =>
  `/api/project-executions/${encodeURIComponent(pid)}`;
const item = (pid: string, d: Delivery) =>
  `${root(pid)}/${d.kind === "import" ? "imports" : "deliveries"}/${encodeURIComponent(d.id)}`;
export const deliveryChunkBytes = 128 * 1024;
export const browserDeliveryLimit = 64 * 1024 * 1024;
export function listDeliveries(pid: string, kind: "delivery" | "import") {
  return api<{ items: Delivery[]; truncated: boolean }>(
    `${root(pid)}/${kind === "import" ? "imports" : "deliveries"}?limit=200`,
    { cacheTtlMs: false },
  );
}
export function deliveryChannels(pid: string) {
  return api<{ items: DeliveryChannel[] }>(`${root(pid)}/deliveries/channels`, {
    cacheTtlMs: false,
  });
}
export function getDeliveryRecord(
  pid: string,
  id: string,
  kind: "delivery" | "import",
) {
  return api<Delivery>(
    `${root(pid)}/${kind === "import" ? "imports" : "deliveries"}/${encodeURIComponent(id)}`,
    { cacheTtlMs: false },
  );
}
export function createDelivery(
  pid: string,
  preview: MergePreview,
  name: string,
  version: string,
  comment: string,
) {
  return api<Delivery>(`${root(pid)}/deliveries`, {
    method: "POST",
    json: {
      runId: preview.runId,
      previewId: preview.id,
      expectedPreviewRevision: preview.revision,
      name,
      version,
      comment,
    },
  });
}
export function inspectDelivery(
  pid: string,
  d: Delivery,
  signal?: AbortSignal,
) {
  return api<Delivery>(`${item(pid, d)}/inspect`, {
    method: "POST",
    json: {},
    signal,
  });
}
export function revokeDelivery(pid: string, d: Delivery, comment: string) {
  return api<Delivery>(`${item(pid, d)}/revoke`, {
    method: "POST",
    json: { expectedRevision: d.revision, comment },
  });
}
export function promoteDelivery(
  pid: string,
  d: Delivery,
  channel: string,
  previous: DeliveryChannel | undefined,
  comment: string,
) {
  return api<DeliveryChannel>(
    `${root(pid)}/deliveries/channels/${encodeURIComponent(channel)}`,
    {
      method: "PUT",
      json: {
        deliveryId: d.id,
        expectedRevision: previous?.revision ?? 0,
        comment,
      },
    },
  );
}
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "浏览器 SHA-256 校验需要 HTTPS 或 localhost 的安全上下文。",
    );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
export async function prepareDeliveryFile(file: File) {
  if (file.size < 2048 || file.size > browserDeliveryLimit)
    throw new Error(
      "浏览器交付包须为 2 KiB–64 MiB；服务端分块 API 支持更大的包。",
    );
  return {
    name: file.name,
    totalBytes: file.size,
    sha256: await sha256Hex(await file.arrayBuffer()),
  };
}
export function beginDeliveryImport(
  pid: string,
  file: { name: string; totalBytes: number; sha256: string },
  signal?: AbortSignal,
) {
  return api<Delivery>(`${root(pid)}/imports`, {
    method: "POST",
    json: file,
    signal,
  });
}
export function finishDeliveryImport(pid: string, d: Delivery) {
  return api<Delivery>(`${item(pid, d)}/finish`, { method: "POST", json: {} });
}
export function abortDeliveryImport(pid: string, d: Delivery) {
  return api<Delivery>(item(pid, d), { method: "DELETE" });
}
export function startImportedRun(pid: string, d: Delivery, revision: number) {
  return api<Run>(`${item(pid, d)}/runs`, {
    method: "POST",
    json: { expectedRevision: revision },
  });
}
// A resumed file must match the server-admitted digest and size. Chunks start at
// the durable runner offset; callers can pause without discarding that receipt.
export async function uploadDeliveryFile(
  pid: string,
  transfer: Delivery,
  file: File,
  sha256: string,
  onProgress: (value: Delivery) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const validate = (receipt: Delivery, minimumOffset: number) => {
    if (
      receipt.id !== transfer.id ||
      receipt.kind !== "import" ||
      receipt.projectId !== pid
    )
      throw new Error("服务器返回了不属于当前项目和传输的回执，请重新核对。");
    if (receipt.sha256 !== sha256 || receipt.totalBytes !== file.size)
      throw new Error("所选文件与原传输的 SHA-256 或大小不同。");
    if (receipt.status !== "uploading")
      throw new Error(`传输状态为 ${receipt.status}，请先核对回执。`);
    const offset = receipt.received ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < minimumOffset ||
      offset > file.size
    )
      throw new Error("服务器返回了无效或没有前进的传输偏移，请重新核对回执。");
  };
  let current = await inspectDelivery(pid, transfer, signal);
  signal.throwIfAborted();
  validate(current, 0);
  onProgress(current);
  while ((current.received ?? 0) < file.size) {
    signal.throwIfAborted();
    const offset = current.received ?? 0;
    const body = await file
      .slice(offset, offset + deliveryChunkBytes)
      .arrayBuffer();
    signal.throwIfAborted();
    if (!body.byteLength)
      throw new Error("无法读取下一块文件字节，传输已停止。");
    current = await api<Delivery>(
      `${item(pid, current)}/chunks?offset=${offset}`,
      {
        method: "PUT",
        body,
        headers: { "Content-Type": "application/octet-stream" },
        signal,
      },
    );
    validate(current, offset + body.byteLength);
    onProgress(current);
  }
  return current;
}
export async function downloadDelivery(
  pid: string,
  d: Delivery,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!d.archive || d.status !== "ready") throw new Error("交付包尚未就绪。");
  if (d.archive.bytes > browserDeliveryLimit)
    throw new Error(
      "此交付包超过浏览器 64 MiB 下载限制，请使用支持 Range 的认证下载 API。",
    );
  const session = getSession();
  const response = await fetch(`${item(pid, d)}/archive`, {
    headers: session ? { Authorization: `Bearer ${session}` } : {},
    signal,
  });
  if (!response.ok) {
    const detail = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new ApiError(
      detail.error ?? "交付包下载失败",
      response.status,
      detail,
    );
  }
  const raw = await response.arrayBuffer();
  if (
    raw.byteLength !== d.archive.bytes ||
    (await sha256Hex(raw)) !== d.archive.sha256
  )
    throw new Error("下载内容的长度或 SHA-256 与交付回执不一致。");
  signal?.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob([raw], { type: "application/x-tar" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `zakura-delivery-${d.id}.tar`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
