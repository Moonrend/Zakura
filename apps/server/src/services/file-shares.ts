import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { WorkspaceFs } from "@zakura/core";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { fileShares, newId, type FileShare } from "../db/schema.js";

const DEFAULT_TTL_MINUTES = 60;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 7 * 24 * 60; // 7 days
/** Align with chat upload limit */
export const MAX_SHARE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_SHARES_PER_AGENT = 50;

export type FileShareDisposition = "inline" | "attachment";

export type FileShareDto = {
  id: string;
  path: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  url: string;
  ttlMinutes: number;
  expiresAt: string;
  disposition: FileShareDisposition;
  downloadCount: number;
  createdAt: string;
};

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function mintToken(): string {
  return `fsh_${randomBytes(24).toString("base64url")}`;
}

function guessMime(fileName: string): string {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    json: "application/json",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    xml: "application/xml",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "file";
}

function clampTtl(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.floor(raw)));
}

export class FileShareService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  publicUrlForToken(token: string): string {
    return `${this.config.publicBaseUrl.replace(/\/$/, "")}/api/files/shared/${encodeURIComponent(token)}`;
  }

  toDto(row: FileShare, url?: string): FileShareDto {
    return {
      id: row.id,
      path: row.path,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      url: url ?? "",
      ttlMinutes: row.ttlMinutes,
      expiresAt: row.expiresAt.toISOString(),
      disposition: (row.disposition === "inline" ? "inline" : "attachment") as FileShareDisposition,
      downloadCount: row.downloadCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Create a time-limited public download URL for a workspace file.
   * Caller must supply a WorkspaceFs already bound to the agent.
   */
  async create(
    tenantId: string,
    agentId: string,
    fs: WorkspaceFs,
    input: {
      path: string;
      ttlMinutes?: number;
      disposition?: FileShareDisposition;
    },
  ): Promise<FileShareDto & { token: string }> {
    const path = String(input.path ?? "").trim();
    if (!path) throw new Error("path is required");

    const st = await fs.stat(path);
    if (st.type !== "file") throw new Error("path must be a regular file");
    if (st.size > MAX_SHARE_FILE_BYTES) {
      throw new Error(
        `file too large to share (${st.size} bytes; max ${MAX_SHARE_FILE_BYTES})`,
      );
    }

    const activeCount = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(fileShares)
      .where(
        and(
          eq(fileShares.agentId, agentId),
          eq(fileShares.status, "active"),
        ),
      );
    if ((activeCount[0]?.n ?? 0) >= MAX_ACTIVE_SHARES_PER_AGENT) {
      throw new Error(
        `too many active file shares (max ${MAX_ACTIVE_SHARES_PER_AGENT}); revoke unused ones first`,
      );
    }

    const ttlMinutes = clampTtl(input.ttlMinutes);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const fileName = basename(path);
    const mimeType = guessMime(fileName);
    const disposition: FileShareDisposition =
      input.disposition === "inline" ? "inline" : "attachment";
    const token = mintToken();
    const id = newId();
    const now = new Date();

    await this.db.insert(fileShares).values({
      id,
      tenantId,
      agentId,
      tokenHash: hashToken(token),
      path,
      fileName,
      mimeType,
      sizeBytes: st.size,
      status: "active",
      ttlMinutes,
      expiresAt,
      downloadCount: 0,
      disposition,
      createdAt: now,
      updatedAt: now,
    });

    const url = this.publicUrlForToken(token);
    return {
      id,
      path,
      fileName,
      mimeType,
      sizeBytes: st.size,
      status: "active",
      url,
      token,
      ttlMinutes,
      expiresAt: expiresAt.toISOString(),
      disposition,
      downloadCount: 0,
      createdAt: now.toISOString(),
    };
  }

  async listForAgent(tenantId: string, agentId: string): Promise<FileShareDto[]> {
    const rows = await this.db
      .select()
      .from(fileShares)
      .where(and(eq(fileShares.tenantId, tenantId), eq(fileShares.agentId, agentId)))
      .orderBy(desc(fileShares.createdAt))
      .limit(100);
    return rows.map((r) => this.toDto(r));
  }

  async revoke(
    tenantId: string,
    agentId: string,
    shareId: string,
  ): Promise<FileShareDto | null> {
    const row = await this.db.query.fileShares.findFirst({
      where: and(
        eq(fileShares.id, shareId),
        eq(fileShares.tenantId, tenantId),
        eq(fileShares.agentId, agentId),
      ),
    });
    if (!row) return null;
    if (row.status !== "active") return this.toDto(row);
    const now = new Date();
    await this.db
      .update(fileShares)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(fileShares.id, shareId));
    return this.toDto({ ...row, status: "revoked", revokedAt: now, updatedAt: now });
  }

  /** Resolve raw token → active share row (marks expired if needed). */
  async resolveByToken(rawToken: string): Promise<FileShare | null> {
    const token = String(rawToken ?? "").trim();
    if (!token.startsWith("fsh_")) return null;
    const row = await this.db.query.fileShares.findFirst({
      where: eq(fileShares.tokenHash, hashToken(token)),
    });
    if (!row) return null;
    if (row.status !== "active") return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.db
        .update(fileShares)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(fileShares.id, row.id));
      return null;
    }
    return row;
  }

  async recordDownload(shareId: string): Promise<void> {
    await this.db
      .update(fileShares)
      .set({
        downloadCount: sql`${fileShares.downloadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(fileShares.id, shareId));
  }

  /** Best-effort cleanup of long-expired rows (optional maintenance). */
  async purgeExpired(olderThanMs = 7 * 24 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.db
      .select({ id: fileShares.id })
      .from(fileShares)
      .where(lt(fileShares.expiresAt, cutoff));
    if (stale.length === 0) return 0;
    await this.db.delete(fileShares).where(lt(fileShares.expiresAt, cutoff));
    return stale.length;
  }
}
