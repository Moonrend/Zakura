import {
  isTransactionalEmailConfigured,
  renderReactEmail,
  sendSystemEmail,
} from "../transactional-email.js";
import { InviteEmail } from "../../emails/invite.js";
import { ResetPasswordEmail } from "../../emails/reset-password.js";
import { VerifyEmail } from "../../emails/verify-email.js";

async function send(to: string, subject: string, element: Parameters<typeof renderReactEmail>[0]): Promise<boolean> {
  if (!(await isTransactionalEmailConfigured())) return false;
  const rendered = await renderReactEmail(element);
  await sendSystemEmail({
    to,
    subject,
    html: rendered.html,
    text: rendered.text,
  });
  return true;
}

export async function sendVerifyEmail(to: string, verifyUrl: string): Promise<boolean> {
  return send(to, "验证你的 Zakura 邮箱", VerifyEmail({ verifyUrl }));
}

export async function sendResetPasswordEmail(to: string, resetUrl: string): Promise<boolean> {
  return send(to, "重置 Zakura 密码", ResetPasswordEmail({ resetUrl }));
}

export async function sendInviteEmail(input: {
  to: string;
  tenantName: string;
  acceptUrl: string;
  role: string;
}): Promise<boolean> {
  return send(input.to, `邀请加入 ${input.tenantName}`, InviteEmail(input));
}
