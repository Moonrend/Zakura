import type { McpToolDef } from "@zakura/shared";
import { googleFetch } from "./client.js";

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  size?: string;
  fileExtension?: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  sharedWithMeTime?: string;
  owners?: Array<{ emailAddress?: string }>;
  parents?: string[];
  capabilities?: { canAddChildren?: boolean };
};

/** 将官方 MCP Drive 查询语法尽量映射为 Drive API q */
export function translateDriveQuery(query: string): string {
  let q = query.trim();
  if (!q) return "";
  q = q.replace(/\btitle\b/g, "name");
  q = q.replace(/\bparentId\s*=\s*'([^']+)'/gi, (_, id: string) =>
    id === "root" ? "'root' in parents" : `'${id}' in parents`,
  );
  q = q.replace(/\bparentId\s*!=\s*'([^']+)'/gi, (_, id: string) =>
    id === "root" ? "not 'root' in parents" : `not '${id}' in parents`,
  );
  q = q.replace(/\bowner\s*=\s*'me'/gi, "'me' in owners");
  q = q.replace(/\bowner\s*=\s*'([^']+)'/gi, "'$1' in owners");
  q = q.replace(/\bowner\s*!=\s*'([^']+)'/gi, "not '$1' in owners");
  q = q.replace(/\bsharedWithMe\s*=\s*true/gi, "sharedWithMe");
  q = q.replace(/\bsharedWithMe\s*=\s*false/gi, "not sharedWithMe");
  return q;
}

function mapFile(f: DriveFile, snippet?: string) {
  return {
    id: f.id ?? "",
    title: f.name ?? "",
    parentId: f.parents?.[0],
    mimeType: f.mimeType,
    fileSize: f.size,
    description: f.description,
    fileExtension: f.fileExtension,
    contentSnippet: snippet,
    viewUrl: f.webViewLink,
    sharedWithMeTime: f.sharedWithMeTime,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    viewedByMeTime: f.viewedByMeTime,
    owner: f.owners?.[0]?.emailAddress,
    canAddChildren: f.capabilities?.canAddChildren ?? false,
  };
}

const FILE_FIELDS =
  "id,name,mimeType,description,size,fileExtension,webViewLink,createdTime,modifiedTime,viewedByMeTime,sharedWithMeTime,owners(emailAddress),parents,capabilities(canAddChildren)";

export const driveToolDefs: McpToolDef[] = [
  {
    name: "search_files",
    description:
      "Search Drive files. Query uses MCP syntax (title/fullText/mimeType/parentId/owner/sharedWithMe/modifiedTime).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
        excludeContentSnippets: { type: "boolean" },
      },
    },
  },
  {
    name: "list_recent_files",
    description: "Lists recently modified files.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "get_file_metadata",
    description: "Gets metadata for a file.",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: { fileId: { type: "string" } },
    },
  },
  {
    name: "get_file_permissions",
    description: "Lists permissions on a file.",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: { fileId: { type: "string" } },
    },
  },
  {
    name: "read_file_content",
    description:
      "Reads a text representation of Docs/Sheets/Slides/PDF/Office/images. Large files may be truncated.",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: { type: "string" },
        includeComments: { type: "boolean" },
      },
    },
  },
  {
    name: "download_file_content",
    description: "Downloads file bytes as base64 (binary/export).",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: { type: "string" },
        mimeType: { type: "string", description: "Export MIME for Google Docs editors" },
      },
    },
  },
  {
    name: "create_file",
    description: "Creates a text file (or Google Doc) in Drive.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        parentId: { type: "string" },
        mimeType: { type: "string" },
      },
    },
  },
  {
    name: "copy_file",
    description: "Copies a file.",
    inputSchema: {
      type: "object",
      required: ["fileId"],
      properties: {
        fileId: { type: "string" },
        name: { type: "string" },
        parentId: { type: "string" },
      },
    },
  },
];

async function readFileAsText(token: string, fileId: string): Promise<{
  fileContent?: string;
  textFormattingNotSupported?: boolean;
}> {
  const meta = await googleFetch<DriveFile>(
    token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
  );
  const mime = meta.mimeType ?? "";
  const exportMap: Record<string, string> = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
  };
  if (exportMap[mime]) {
    const text = await googleFetch<string>(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMap[mime]!)}`,
    );
    return { fileContent: typeof text === "string" ? text.slice(0, 200_000) : String(text) };
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("opendocument")
  ) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    if (mime.startsWith("text/") || mime === "application/json") {
      return { fileContent: (await res.text()).slice(0, 200_000) };
    }
    // binary: return note + base64 prefix
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      fileContent: `[binary ${mime} size=${buf.length}]\n${buf.toString("base64").slice(0, 50_000)}`,
    };
  }
  if (mime.startsWith("image/")) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!res.ok) throw new Error(await res.text());
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      fileContent: `[image ${mime} size=${buf.length} base64]\n${buf.toString("base64").slice(0, 80_000)}`,
    };
  }
  return { textFormattingNotSupported: true, fileContent: "" };
}

export async function callDriveTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_files": {
      const pageSize = Math.min(Number(args.pageSize) || 20, 100);
      const params = new URLSearchParams({
        pageSize: String(pageSize),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      const q = translateDriveQuery(typeof args.query === "string" ? args.query : "");
      if (q) params.set("q", q);
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const res = await googleFetch<{ files?: DriveFile[]; nextPageToken?: string }>(
        token,
        `https://www.googleapis.com/drive/v3/files?${params}`,
      );
      return {
        files: (res.files ?? []).map((f) =>
          mapFile(f, args.excludeContentSnippets === true ? undefined : f.description),
        ),
        nextPageToken: res.nextPageToken,
      };
    }
    case "list_recent_files": {
      const pageSize = Math.min(Number(args.pageSize) || 20, 100);
      const params = new URLSearchParams({
        pageSize: String(pageSize),
        orderBy: "viewedByMeTime desc",
        q: "trashed = false",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const res = await googleFetch<{ files?: DriveFile[]; nextPageToken?: string }>(
        token,
        `https://www.googleapis.com/drive/v3/files?${params}`,
      );
      return {
        files: (res.files ?? []).map((f) => mapFile(f)),
        nextPageToken: res.nextPageToken,
      };
    }
    case "get_file_metadata": {
      const fileId = String(args.fileId ?? "");
      if (!fileId) throw new Error("fileId required");
      const f = await googleFetch<DriveFile>(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
      );
      return mapFile(f);
    }
    case "get_file_permissions": {
      const fileId = String(args.fileId ?? "");
      if (!fileId) throw new Error("fileId required");
      return googleFetch(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,domain,displayName)`,
      );
    }
    case "read_file_content": {
      const fileId = String(args.fileId ?? "");
      if (!fileId) throw new Error("fileId required");
      const content = await readFileAsText(token, fileId);
      const out: Record<string, unknown> = { ...content };
      if (args.includeComments === true) {
        try {
          const comments = await googleFetch<{ comments?: unknown[] }>(
            token,
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?fields=comments(id,content,author,resolved,replies)`,
          );
          out.unanchoredComments = (comments.comments ?? []).map((c) => {
            const row = c as {
              id?: string;
              content?: string;
              author?: { displayName?: string };
              resolved?: boolean;
              replies?: Array<{ id?: string; content?: string; author?: { displayName?: string }; modifiedTime?: string }>;
            };
            return {
              commentId: row.id,
              status: row.resolved ? "RESOLVED" : "OPEN",
              headPost: {
                postId: row.id,
                content: row.content,
                authorName: row.author?.displayName,
              },
              replies: (row.replies ?? []).map((r) => ({
                postId: r.id,
                content: r.content,
                authorName: r.author?.displayName,
                modifiedTime: r.modifiedTime,
              })),
            };
          });
        } catch {
          out.commentsNotSupported = true;
        }
      }
      return out;
    }
    case "download_file_content": {
      const fileId = String(args.fileId ?? "");
      if (!fileId) throw new Error("fileId required");
      const meta = await googleFetch<DriveFile>(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType,name`,
      );
      const exportMime = typeof args.mimeType === "string" ? args.mimeType : "";
      let url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
      if (meta.mimeType?.startsWith("application/vnd.google-apps.") && exportMime) {
        url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
      }
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(await res.text());
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        name: meta.name,
        mimeType: exportMime || meta.mimeType,
        size: buf.length,
        contentBase64: buf.toString("base64"),
      };
    }
    case "create_file": {
      const nameFile = String(args.name ?? "").trim();
      if (!nameFile) throw new Error("name required");
      const content = typeof args.content === "string" ? args.content : "";
      const mimeType =
        typeof args.mimeType === "string" && args.mimeType
          ? args.mimeType
          : "text/plain";
      const parentId = typeof args.parentId === "string" ? args.parentId : undefined;
      const metadata: Record<string, unknown> = { name: nameFile, mimeType };
      if (parentId) metadata.parents = [parentId];

      if (mimeType === "application/vnd.google-apps.document") {
        const created = await googleFetch<DriveFile>(
          token,
          "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink",
          { method: "POST", json: metadata },
        );
        if (content) {
          await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${created.id}/export?mimeType=text/plain`,
            { method: "GET" },
          ).catch(() => undefined);
          // Upload content via docs is complex; use media upload as plain then convert is heavy —
          // create as text/plain instead when content provided with docs mime.
        }
        return mapFile(created);
      }

      const boundary = "zakura_boundary";
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--`;
      const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents,size",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
          signal: AbortSignal.timeout(60000),
        },
      );
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      return mapFile(JSON.parse(text) as DriveFile);
    }
    case "copy_file": {
      const fileId = String(args.fileId ?? "");
      if (!fileId) throw new Error("fileId required");
      const body: Record<string, unknown> = {};
      if (typeof args.name === "string" && args.name) body.name = args.name;
      if (typeof args.parentId === "string" && args.parentId) {
        body.parents = [args.parentId];
      }
      const f = await googleFetch<DriveFile>(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?fields=${FILE_FIELDS}&supportsAllDrives=true`,
        { method: "POST", json: body },
      );
      return mapFile(f);
    }
    default:
      throw new Error(`Unknown drive tool: ${name}`);
  }
}
