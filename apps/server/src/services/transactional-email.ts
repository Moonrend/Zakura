/**
 * 平台系统发信：仅 Amail，配置来自管理页（DB settings），不读环境变量。
 */
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import type { Db } from "../db/client.js";
import { CrisisSupportEmail, crisisSupportText } from "../emails/crisis-support.js";
import {
  loadPlatformTransactionalEmailResolved,
  type PlatformTransactionalEmailResolved,
} from "./platform-transactional-email.js";

export type SendSystemEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

type Binder = { db: Db; secret: string };

let binder: Binder | null = null;

/** 在 createApiApp 启动时绑定 DB，供运行时发信读取配置 */
export function bindTransactionalEmail(deps: Binder): void {
  binder = deps;
}

function requireBinder(): Binder {
  if (!binder) {
    throw new Error("系统邮件服务未初始化");
  }
  return binder;
}

export async function resolveTransactionalEmailConfig(): Promise<PlatformTransactionalEmailResolved | null> {
  if (!binder) return null;
  const resolved = await loadPlatformTransactionalEmailResolved(binder.db, binder.secret);
  return resolved.enabled ? resolved : null;
}

export async function isTransactionalEmailConfigured(): Promise<boolean> {
  return (await resolveTransactionalEmailConfig()) != null;
}

function asList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value])
    .map((item) => item.trim())
    .filter(Boolean);
}

async function sendViaAmail(
  config: PlatformTransactionalEmailResolved,
  mail: SendSystemEmailInput,
): Promise<unknown> {
  if (!config.apiToken) throw new Error("系统邮件 Amail 缺少 API Token");
  const { Amail } = await import("@wydev/amail");
  const client = new Amail(config.apiToken, {
    baseUrl: config.baseUrl || undefined,
    providerId: config.providerId || undefined,
  });
  const result = await client.emails.send({
    from: config.fromEmail,
    to: asList(mail.to),
    subject: mail.subject,
    html: mail.html,
    ...(mail.text ? { text: mail.text } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  });
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}`);
  return result.data;
}

/** 发送系统事务邮件；未在管理页配置时抛错。 */
export async function sendSystemEmail(input: SendSystemEmailInput): Promise<unknown> {
  requireBinder();
  const config = await resolveTransactionalEmailConfig();
  if (!config) {
    throw new Error("系统邮件未配置：请在管理页启用 Amail 并填写发件地址与 API Token");
  }
  const to = asList(input.to);
  if (!to.length) throw new Error("to 必填");
  if (!input.subject.trim()) throw new Error("subject 必填");
  if (!input.html.trim()) throw new Error("html 必填");
  return sendViaAmail(config, input);
}

export async function renderReactEmail(element: ReactElement): Promise<{
  html: string;
  text: string;
}> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}

/** 迅即发送「Zakura支持资源」危机支持邮件 */
export async function sendCrisisSupportEmail(to: string | string[]): Promise<unknown> {
  const html = await render(CrisisSupportEmail());
  return sendSystemEmail({
    to,
    subject: "Zakura支持资源",
    html,
    text: crisisSupportText(),
  });
}
