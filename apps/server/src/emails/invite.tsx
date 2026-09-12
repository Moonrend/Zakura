import { Link, Text } from "@react-email/components";
import { AccountEmailLayout, accountEmailStyles } from "./account-layout.js";

const roleLabels: Record<string, string> = { admin: "管理员", member: "成员" };

export function inviteEmailText(input: { tenantName: string; acceptUrl: string; role: string }): string {
  const role = roleLabels[input.role] ?? input.role;
  return [
    `你被邀请以「${role}」加入 ${input.tenantName}。`,
    "",
    `接受邀请：${input.acceptUrl}`,
    "",
    "链接 72 小时内有效。",
  ].join("\n");
}

export function InviteEmail(input: { tenantName: string; acceptUrl: string; role: string }) {
  const role = roleLabels[input.role] ?? input.role;
  return (
    <AccountEmailLayout preview={`邀请加入 ${input.tenantName}`} title="团队邀请">
      <Text style={accountEmailStyles.paragraph}>
        你被邀请以「{role}」加入 {input.tenantName}。
      </Text>
      <Text style={accountEmailStyles.paragraph}>
        <Link href={input.acceptUrl} style={accountEmailStyles.link}>
          接受邀请
        </Link>
      </Text>
      <Text style={accountEmailStyles.paragraph}>链接 72 小时内有效。</Text>
    </AccountEmailLayout>
  );
}
