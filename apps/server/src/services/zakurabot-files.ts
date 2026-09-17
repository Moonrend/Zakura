import { and, eq } from "drizzle-orm";
import type { CloudAgentAttachment } from "@zakura/shared";
import type { Db } from "../db/client.js";
import { newId, zakurabotFiles, type ZakurabotFile } from "../db/schema.js";
import type { AgentService } from "./agents.js";
import type { ServerWorkspaceFsProvider } from "./workspace-fs-provider.js";
import type { ZakurabotConversation } from "./zakurabot-store.js";
import { ZAKURABOT_MAX_FILE_BYTES, type ZakurabotFileView } from "./zakurabot-protocol.js";

export class ZakurabotFileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413 | 503) { super(message); }
}

export class ZakurabotFileService {
  constructor(private readonly db: Db, private readonly deps: {
    agents: Pick<AgentService, "get">;
    workspaceFs: Pick<ServerWorkspaceFsProvider, "forAgentBinding">;
    publicBaseUrl: string;
  }) {}

  private async fs(c: ZakurabotConversation) {
    const agent = await this.deps.agents.get(c.tenantId, c.agentId);
    if (!agent) throw new ZakurabotFileError("Agent not found", 404);
    if (!agent.enableFs) throw new ZakurabotFileError("Filesystem is disabled for this agent", 403);
    return this.deps.workspaceFs.forAgentBinding(agent);
  }

  view(file: ZakurabotFile): ZakurabotFileView {
    const type = file.mime.startsWith("image/") ? "image" : file.mime.startsWith("audio/") ? "audio" :
      file.mime.startsWith("video/") ? "video" : "file";
    return { id: file.id, name: file.name, mime: file.mime, size: file.size, type,
      url: `${this.deps.publicBaseUrl.replace(/\/+$/, "")}/api/zakurabot/agents/${encodeURIComponent(file.agentId)}/files/${encodeURIComponent(file.id)}` };
  }

  async upload(c: ZakurabotConversation, file: { name: string; type: string; data: Buffer }) {
    if (!file.data.length || file.data.length > ZAKURABOT_MAX_FILE_BYTES) {
      throw new ZakurabotFileError("Files must be nonempty and at most 16 MiB", 413);
    }
    // Never accept a destination path; even a filename containing traversal stays inside its generated directory.
    const name = file.name.replace(/\\/g, "/").split("/").pop()!.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
    if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 180) throw new ZakurabotFileError("Invalid filename", 400);
    const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.type) ? file.type.toLowerCase() : "application/octet-stream";
    const id = newId();
    const path = `/workspace/uploads/zakurabot/${c.deviceId}/${id}/${name}`;
    const fs = await this.fs(c);
    await fs.writeBytes(path, file.data);
    try {
      const [row] = await this.db.insert(zakurabotFiles).values({ id, ...c, path, name, mime, size: file.data.length }).returning();
      return this.view(row!);
    } catch (error) {
      await fs.delete(path).catch(() => undefined);
      throw error;
    }
  }

  private async get(c: ZakurabotConversation, fileId: string) {
    const [row] = await this.db.select().from(zakurabotFiles).where(and(
      eq(zakurabotFiles.id, fileId), eq(zakurabotFiles.tenantId, c.tenantId), eq(zakurabotFiles.deviceId, c.deviceId),
      eq(zakurabotFiles.bindingId, c.bindingId), eq(zakurabotFiles.agentId, c.agentId),
    )).limit(1);
    if (!row) throw new ZakurabotFileError("File not found in this conversation", 404);
    return row;
  }

  async download(c: ZakurabotConversation, fileId: string) {
    const row = await this.get(c, fileId);
    const fs = await this.fs(c);
    const stat = await fs.stat(row.path);
    if (stat.type !== "file") throw new ZakurabotFileError("File not found", 404);
    if (stat.size > ZAKURABOT_MAX_FILE_BYTES) throw new ZakurabotFileError("File is too large", 413);
    const { data } = await fs.readBytes(row.path);
    if (data.length > ZAKURABOT_MAX_FILE_BYTES) throw new ZakurabotFileError("File is too large", 413);
    return { file: this.view({ ...row, size: data.length }), data };
  }

  async resolveAttachments(c: ZakurabotConversation, ids: string[]) {
    const fs = await this.fs(c);
    const views: ZakurabotFileView[] = [];
    const attachments: CloudAgentAttachment[] = [];
    for (const id of ids) {
      const row = await this.get(c, id);
      const stat = await fs.stat(row.path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new ZakurabotFileError("Attachment is no longer available; upload it again", 404);
        }
        throw error;
      });
      if (stat.type !== "file" || stat.size === 0 || stat.size > ZAKURABOT_MAX_FILE_BYTES) {
        throw new ZakurabotFileError("Attachment is missing, empty, or too large", 400);
      }
      views.push(this.view({ ...row, size: stat.size }));
      attachments.push({ name: row.name, path: row.path, mime: row.mime, size: stat.size,
        kind: row.mime.startsWith("image/") ? "image" : "file" });
    }
    return { views, attachments };
  }
}
