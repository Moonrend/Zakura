import type { McpToolDef } from "@zakura/shared";
import {
  decodeBase64Url,
  googleFetch,
  headerValue,
  parseAddressList,
  toIsoDate,
} from "./client.js";

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: {
    mimeType?: string;
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; attachmentId?: string; size?: number };
    parts?: Array<{
      mimeType?: string;
      filename?: string;
      body?: { data?: string; attachmentId?: string };
      parts?: unknown[];
    }>;
  };
  internalDate?: string;
};

function extractPlaintext(payload: GmailMessage["payload"]): string {
  if (!payload) return "";
  if (payload.mimeType?.startsWith("text/plain") && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  const walk = (parts?: GmailMessage["payload"] extends infer P
    ? P extends { parts?: infer X }
      ? X
      : never
    : never): string => {
    if (!Array.isArray(parts)) return "";
    for (const p of parts as Array<{
      mimeType?: string;
      body?: { data?: string };
      parts?: unknown[];
    }>) {
      if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
      const nested = walk(p.parts as typeof parts);
      if (nested) return nested;
    }
    return "";
  };
  return walk(payload.parts as never);
}

function extractAttachmentIds(payload: GmailMessage["payload"]): string[] {
  const ids: string[] = [];
  const walk = (parts?: Array<{ body?: { attachmentId?: string }; parts?: unknown[] }>) => {
    if (!parts) return;
    for (const p of parts) {
      if (p.body?.attachmentId) ids.push(p.body.attachmentId);
      if (Array.isArray(p.parts)) walk(p.parts as typeof parts);
    }
  };
  if (payload?.body?.attachmentId) ids.push(payload.body.attachmentId);
  walk(payload?.parts as never);
  return ids;
}

function mapMessage(msg: GmailMessage, full: boolean) {
  const headers = msg.payload?.headers;
  return {
    id: msg.id ?? "",
    snippet: msg.snippet ?? "",
    subject: headerValue(headers, "Subject"),
    sender: headerValue(headers, "From"),
    toRecipients: parseAddressList(headerValue(headers, "To")),
    ccRecipients: parseAddressList(headerValue(headers, "Cc")),
    date: toIsoDate(headerValue(headers, "Date") || msg.internalDate || ""),
    plaintextBody: full ? extractPlaintext(msg.payload) : undefined,
    attachmentIds: full ? extractAttachmentIds(msg.payload) : undefined,
  };
}

function buildMime(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
  lines.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("MIME-Version: 1.0");
  if (opts.htmlBody) {
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("");
    lines.push(opts.htmlBody);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("");
    lines.push(opts.body ?? "");
  }
  return lines.join("\r\n");
}

export const gmailToolDefs: McpToolDef[] = [
  {
    name: "search_threads",
    description:
      "Lists email threads. Optional Gmail query (from:/to:/subject:/is:unread etc.). Full bodies via get_thread.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pageSize: { type: "integer", description: "Default 20, max 50" },
        pageToken: { type: "string" },
        includeTrash: { type: "boolean" },
      },
    },
  },
  {
    name: "get_thread",
    description: "Retrieves a thread with messages. messageFormat: MINIMAL | FULL_CONTENT (default).",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
        messageFormat: { type: "string", enum: ["MINIMAL", "FULL_CONTENT"] },
      },
    },
  },
  {
    name: "create_draft",
    description: "Creates a draft. to[] required. Optional replyToMessageId for replies.",
    inputSchema: {
      type: "object",
      required: ["to"],
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        htmlBody: { type: "string" },
        replyToMessageId: { type: "string" },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Sends an email immediately (not a draft). to[] required. Gated by permission gmail.send.",
    inputSchema: {
      type: "object",
      required: ["to"],
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        htmlBody: { type: "string" },
        replyToMessageId: { type: "string" },
      },
    },
  },
  {
    name: "send_draft",
    description: "Sends an existing draft by draftId. Gated by permission gmail.send.",
    inputSchema: {
      type: "object",
      required: ["draftId"],
      properties: {
        draftId: { type: "string" },
      },
    },
  },
  {
    name: "list_drafts",
    description: "Lists draft emails.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "list_labels",
    description: "Lists Gmail labels (system + user).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_label",
    description: "Creates a user label.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "label_message",
    description: "Adds labelIds to a message.",
    inputSchema: {
      type: "object",
      required: ["messageId", "labelIds"],
      properties: {
        messageId: { type: "string" },
        labelIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "unlabel_message",
    description: "Removes labelIds from a message.",
    inputSchema: {
      type: "object",
      required: ["messageId", "labelIds"],
      properties: {
        messageId: { type: "string" },
        labelIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "label_thread",
    description: "Adds labelIds to all messages in a thread.",
    inputSchema: {
      type: "object",
      required: ["threadId", "labelIds"],
      properties: {
        threadId: { type: "string" },
        labelIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "unlabel_thread",
    description: "Removes labelIds from all messages in a thread.",
    inputSchema: {
      type: "object",
      required: ["threadId", "labelIds"],
      properties: {
        threadId: { type: "string" },
        labelIds: { type: "array", items: { type: "string" } },
      },
    },
  },
];

async function resolveReplyHeaders(
  token: string,
  replyToMessageId: string,
): Promise<{ inReplyTo: string; references: string; threadId?: string }> {
  if (!replyToMessageId) return { inReplyTo: "", references: "" };
  const orig = await googleFetch<GmailMessage>(
    token,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(replyToMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
  );
  const inReplyTo = headerValue(orig.payload?.headers, "Message-ID");
  const prevRef = headerValue(orig.payload?.headers, "References");
  return {
    inReplyTo,
    references: [prevRef, inReplyTo].filter(Boolean).join(" "),
    threadId: orig.threadId,
  };
}

function encodeMimeRaw(raw: string): string {
  return Buffer.from(raw).toString("base64url").replace(/=+$/, "");
}

export async function callGmailTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_threads": {
      const pageSize = Math.min(Number(args.pageSize) || 20, 50);
      const q = typeof args.query === "string" ? args.query : "";
      const includeTrash = args.includeTrash === true;
      const params = new URLSearchParams({
        maxResults: String(pageSize),
        q: includeTrash && q ? `${q} in:anywhere` : q,
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      const list = await googleFetch<{
        threads?: Array<{ id: string }>;
        nextPageToken?: string;
      }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`);
      const threads = [];
      for (const t of list.threads ?? []) {
        const full = await googleFetch<{ id?: string; messages?: GmailMessage[] }>(
          token,
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        threads.push({
          id: full.id ?? t.id,
          messages: (full.messages ?? []).map((m) => mapMessage(m, false)),
        });
      }
      return { threads, nextPageToken: list.nextPageToken };
    }
    case "get_thread": {
      const threadId = String(args.threadId ?? "");
      if (!threadId) throw new Error("threadId required");
      const format =
        String(args.messageFormat ?? "FULL_CONTENT") === "MINIMAL" ? "metadata" : "full";
      const url =
        format === "full"
          ? `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`
          : `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`;
      const full = await googleFetch<{ id?: string; messages?: GmailMessage[] }>(token, url);
      return {
        id: full.id ?? threadId,
        messages: (full.messages ?? []).map((m) => mapMessage(m, format === "full")),
      };
    }
    case "create_draft":
    case "send_message": {
      const to = Array.isArray(args.to) ? args.to.map(String) : [];
      if (!to.length) throw new Error("to required");
      const replyTo = typeof args.replyToMessageId === "string" ? args.replyToMessageId : "";
      const reply = await resolveReplyHeaders(token, replyTo);
      const raw = buildMime({
        to,
        cc: Array.isArray(args.cc) ? args.cc.map(String) : undefined,
        bcc: Array.isArray(args.bcc) ? args.bcc.map(String) : undefined,
        subject: String(args.subject ?? ""),
        body: typeof args.body === "string" ? args.body : undefined,
        htmlBody: typeof args.htmlBody === "string" ? args.htmlBody : undefined,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });
      const encoded = encodeMimeRaw(raw);
      if (name === "create_draft") {
        const created = await googleFetch<{
          id?: string;
          message?: GmailMessage;
        }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
          method: "POST",
          json: {
            message: {
              raw: encoded,
              threadId: reply.threadId,
            },
          },
        });
        const msg = created.message;
        return {
          id: created.id ?? "",
          subject: String(args.subject ?? ""),
          threadId: msg?.threadId ?? reply.threadId ?? "",
          toRecipients: to,
          ccRecipients: Array.isArray(args.cc) ? args.cc.map(String) : [],
          bccRecipients: Array.isArray(args.bcc) ? args.bcc.map(String) : [],
          plaintextBody: typeof args.body === "string" ? args.body : "",
          date: new Date().toISOString().slice(0, 10),
        };
      }
      const sent = await googleFetch<GmailMessage>(
        token,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          json: {
            raw: encoded,
            threadId: reply.threadId,
          },
        },
      );
      return {
        id: sent.id ?? "",
        threadId: sent.threadId ?? reply.threadId ?? "",
        labelIds: sent.labelIds ?? [],
        toRecipients: to,
        subject: String(args.subject ?? ""),
      };
    }
    case "send_draft": {
      const draftId = String(args.draftId ?? "").trim();
      if (!draftId) throw new Error("draftId required");
      const sent = await googleFetch<{ id?: string; message?: GmailMessage }>(
        token,
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        { method: "POST", json: { id: draftId } },
      );
      return {
        draftId,
        id: sent.message?.id ?? sent.id ?? "",
        threadId: sent.message?.threadId ?? "",
        labelIds: sent.message?.labelIds ?? [],
      };
    }
    case "list_drafts": {
      const params = new URLSearchParams({
        maxResults: String(Math.min(Number(args.pageSize) || 20, 50)),
      });
      if (typeof args.pageToken === "string" && args.pageToken) {
        params.set("pageToken", args.pageToken);
      }
      return googleFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/drafts?${params}`);
    }
    case "list_labels": {
      const res = await googleFetch<{ labels?: Array<Record<string, unknown>> }>(
        token,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      );
      return { labels: res.labels ?? [] };
    }
    case "create_label": {
      const nameLabel = String(args.name ?? "").trim();
      if (!nameLabel) throw new Error("name required");
      return googleFetch(token, "https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        method: "POST",
        json: { name: nameLabel, labelListVisibility: "labelShow", messageListVisibility: "show" },
      });
    }
    case "label_message":
    case "unlabel_message": {
      const messageId = String(args.messageId ?? "");
      const labelIds = Array.isArray(args.labelIds) ? args.labelIds.map(String) : [];
      if (!messageId || !labelIds.length) throw new Error("messageId and labelIds required");
      const body =
        name === "label_message"
          ? { addLabelIds: labelIds }
          : { removeLabelIds: labelIds };
      return googleFetch(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
        { method: "POST", json: body },
      );
    }
    case "label_thread":
    case "unlabel_thread": {
      const threadId = String(args.threadId ?? "");
      const labelIds = Array.isArray(args.labelIds) ? args.labelIds.map(String) : [];
      if (!threadId || !labelIds.length) throw new Error("threadId and labelIds required");
      const body =
        name === "label_thread"
          ? { addLabelIds: labelIds }
          : { removeLabelIds: labelIds };
      return googleFetch(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}/modify`,
        { method: "POST", json: body },
      );
    }
    default:
      throw new Error(`Unknown gmail tool: ${name}`);
  }
}
