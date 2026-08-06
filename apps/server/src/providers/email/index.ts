import { textResult } from "@zakura/core";
import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import nodemailer from "nodemailer";

export type EmailProduct = "smtp" | "mailgun" | "resendapi" | "amail" | "bettermail";

const PRODUCTS: EmailProduct[] = ["smtp", "mailgun", "resendapi", "amail", "bettermail"];

const configSchema: ProviderConfigSchema = {
  type: "object",
  title: "邮箱",
  required: ["product"],
  properties: {
    product: { type: "string", enum: PRODUCTS },
    apiToken: { type: "string", format: "password" },
    baseUrl: { type: "string" },
    fromEmail: { type: "string" },
    providerId: { type: "string" },
    smtpHost: { type: "string" },
    smtpPort: { type: "number" },
    smtpSecure: { type: "boolean" },
    smtpUser: { type: "string" },
    smtpPassword: { type: "string", format: "password" },
    mailgunDomain: { type: "string" },
    mailgunRegion: { type: "string" },
    mailbox: { type: "string" },
    allowedEmails: { type: "string" },
    inboundEnabled: { type: "boolean" },
    inboundAgentId: { type: "string" },
  },
};

const sendTool: McpToolDef = {
  name: "send_email",
  description:
    "发送邮件。to 可以是邮箱字符串或邮箱数组；支持 subject、text、html、cc、bcc、replyTo。",
  inputSchema: {
    type: "object",
    required: ["to", "subject"],
    properties: {
      to: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      cc: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      bcc: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      replyTo: { type: "string" },
      from: { type: "string", description: "可选；默认使用连接器的发件地址" },
    },
  },
};

const receiveTool: McpToolDef = {
  name: "receive_emails",
  description: "从收件箱读取邮件。Bettermail 的读取请求会消费并删除已返回的邮件。",
  inputSchema: {
    type: "object",
    properties: {
      mailbox: { type: "string", description: "收件邮箱；留空使用连接器设置" },
      limit: { type: "integer", description: "最多读取数量，默认 20，最大 50" },
    },
  },
};

const listSentTool: McpToolDef = {
  name: "list_sent_emails",
  description: "列出 Amail 已发送邮件。",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", description: "默认 20，最大 100" } },
  },
};

function parseProduct(config: Record<string, unknown>): EmailProduct {
  const raw =
    typeof config.product === "string"
      ? config.product
      : typeof config.mcpUrl === "string"
        ? config.mcpUrl
        : "";
  const value = raw.trim().toLowerCase().replace(/^zakura:\/\/email\//, "");
  if (PRODUCTS.includes(value as EmailProduct)) return value as EmailProduct;
  throw new Error("config.product 须为 smtp | mailgun | resendapi | amail | bettermail");
}

function stringValue(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === "string" ? config[key].trim() : "";
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return typeof value === "string"
    ? value
        .split(/[\s,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function recipients(args: Record<string, unknown>, key: string): string[] {
  return listValue(args[key]);
}

function requireFrom(handle: InstanceHandle, args: Record<string, unknown>): string {
  const configured = stringValue(handle.config, "fromEmail");
  const requested = stringValue(args, "from");
  if (configured && requested && configured.toLowerCase() !== requested.toLowerCase()) {
    throw new Error("from 必须与连接器配置的默认发件地址一致");
  }
  const from = configured || requested;
  if (!from) throw new Error("缺少发件地址：请配置 fromEmail 或在工具参数中传入 from");
  return from;
}

function mailArgs(handle: InstanceHandle, args: Record<string, unknown>) {
  const to = recipients(args, "to");
  if (!to.length) throw new Error("to 必填");
  const subject = stringValue(args, "subject");
  if (!subject) throw new Error("subject 必填");
  return {
    from: requireFrom(handle, args),
    to,
    subject,
    text: stringValue(args, "text"),
    html: stringValue(args, "html"),
    cc: recipients(args, "cc"),
    bcc: recipients(args, "bcc"),
    replyTo: stringValue(args, "replyTo"),
  };
}

function jsonHeaders(token: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function sendSmtp(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const host = stringValue(handle.config, "smtpHost");
  const user = stringValue(handle.config, "smtpUser");
  const pass = stringValue(handle.config, "smtpPassword");
  const port = Number(handle.config.smtpPort ?? 465);
  if (!host || !user || !pass) throw new Error("SMTP 缺少 smtpHost、smtpUser 或 smtpPassword");
  const transport = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 465,
    secure: handle.config.smtpSecure !== false && String(handle.config.smtpSecure).toLowerCase() !== "false",
    auth: { user, pass },
  });
  const mail = mailArgs(handle, args);
  const info = await transport.sendMail({
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text || undefined,
    html: mail.html || undefined,
    cc: mail.cc.length ? mail.cc : undefined,
    bcc: mail.bcc.length ? mail.bcc : undefined,
    replyTo: mail.replyTo || undefined,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

async function sendMailgun(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const token = stringValue(handle.config, "apiToken");
  const domain = stringValue(handle.config, "mailgunDomain");
  if (!token || !domain) throw new Error("Mailgun 缺少 apiToken 或 mailgunDomain");
  const region = stringValue(handle.config, "mailgunRegion") || "api";
  const mail = mailArgs(handle, args);
  const body = new URLSearchParams();
  body.set("from", mail.from);
  body.set("to", mail.to.join(","));
  body.set("subject", mail.subject);
  if (mail.text) body.set("text", mail.text);
  if (mail.html) body.set("html", mail.html);
  if (mail.cc.length) body.set("cc", mail.cc.join(","));
  if (mail.bcc.length) body.set("bcc", mail.bcc.join(","));
  if (mail.replyTo) body.set("h:Reply-To", mail.replyTo);
  const auth = Buffer.from(`api:${token}`).toString("base64");
  const response = await fetch(`https://${region}.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return readJson(response);
}

async function sendResend(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const token = stringValue(handle.config, "apiToken");
  if (!token) throw new Error("Resend API 缺少 apiToken");
  const mail = mailArgs(handle, args);
  const response = await fetch(stringValue(handle.config, "baseUrl") || "https://api.resend.com/emails", {
    method: "POST",
    headers: { ...Object.fromEntries(jsonHeaders("").entries()), "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.cc.length ? { cc: mail.cc } : {}),
      ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  return readJson(response);
}

async function sendAmail(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const token = stringValue(handle.config, "apiToken");
  if (!token) throw new Error("Amail 缺少 apiToken");
  const { Amail } = await import("@wydev/amail");
  const client = new Amail(token, {
    baseUrl: stringValue(handle.config, "baseUrl") || undefined,
    providerId: stringValue(handle.config, "providerId") || undefined,
  });
  const mail = mailArgs(handle, args);
  const result = await client.emails.send({
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    ...(mail.text ? { text: mail.text } : {}),
    ...(mail.html ? { html: mail.html } : {}),
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  });
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}`);
  return result.data;
}

async function listAmail(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const token = stringValue(handle.config, "apiToken");
  if (!token) throw new Error("Amail 缺少 apiToken");
  const { Amail } = await import("@wydev/amail");
  const client = new Amail(token, {
    baseUrl: stringValue(handle.config, "baseUrl") || undefined,
    providerId: stringValue(handle.config, "providerId") || undefined,
  });
  const result = await client.emails.list({ limit: Math.min(Number(args.limit) || 20, 100) });
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}`);
  return result.data;
}

async function receiveBettermail(handle: InstanceHandle, args: Record<string, unknown>): Promise<unknown> {
  const baseUrl = stringValue(handle.config, "baseUrl");
  const token = stringValue(handle.config, "apiToken");
  const mailbox = stringValue(args, "mailbox") || stringValue(handle.config, "mailbox");
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  if (!baseUrl) throw new Error("Bettermail 缺少 baseUrl");
  if (!mailbox) throw new Error("Bettermail 缺少 mailbox");
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-API-Key", token);
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/mails`, {
    method: "POST",
    headers: { ...Object.fromEntries(headers.entries()), "Content-Type": "application/json" },
    body: JSON.stringify({ to: mailbox, limit }),
    signal: AbortSignal.timeout(60_000),
  });
  return readJson(response);
}

function toolsFor(product: EmailProduct): McpToolDef[] {
  if (product === "bettermail") return [receiveTool];
  if (product === "amail") return [sendTool, listSentTool];
  return [sendTool];
}

async function callEmailTool(
  handle: InstanceHandle,
  product: EmailProduct,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "send_email") {
    if (product === "smtp") return sendSmtp(handle, args);
    if (product === "mailgun") return sendMailgun(handle, args);
    if (product === "resendapi") return sendResend(handle, args);
    if (product === "amail") return sendAmail(handle, args);
  }
  if (name === "list_sent_emails" && product === "amail") return listAmail(handle, args);
  if (name === "receive_emails" && product === "bettermail") return receiveBettermail(handle, args);
  throw new Error(`邮箱连接器不支持工具 ${name}`);
}

export function emailBuiltinUrl(product: EmailProduct): string {
  return `zakura://email/${product}`;
}

export function createEmailProvider(): ProviderPlugin {
  return {
    id: "email",
    name: "邮箱",
    description: "统一接入 SMTP、Mailgun、Resend API、Amail 与 Bettermail。",
    version: "1.0.0",
    category: "connector",
    capabilities: ["tools", "builtin"],
    configSchema,
    validateConfig(config) {
      const product = parseProduct(config);
      return { ...config, product, mcpUrl: emailBuiltinUrl(product) };
    },
    createRuntimeSpec(config) {
      return { containers: [], endpointTemplate: emailBuiltinUrl(parseProduct(config)) };
    },
    async healthCheck(handle) {
      try {
        const product = parseProduct(handle.config);
        if (product === "smtp") {
          if (!stringValue(handle.config, "smtpHost")) throw new Error("SMTP 缺少 smtpHost");
        } else if (!stringValue(handle.config, "apiToken")) {
          throw new Error(`${product} 缺少 apiToken`);
        }
        return { status: "healthy", message: `ok (${product})` };
      } catch (error) {
        return { status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async listTools(handle) {
      return toolsFor(parseProduct(handle.config));
    },
    async callTool(handle, toolName, args) {
      try {
        return textResult(
          JSON.stringify(await callEmailTool(handle, parseProduct(handle.config), toolName, args), null, 2),
        );
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
