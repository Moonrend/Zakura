import { Link, Text } from "@react-email/components";
import { AccountEmailLayout, accountEmailStyles } from "./account-layout.js";

export function resetPasswordText(resetUrl: string): string {
  return ["你正在重置 Zakura 密码。", "", `打开链接设置新密码：${resetUrl}`, "", "如果不是你本人操作，请忽略此邮件。"].join("\n");
}

export function ResetPasswordEmail({ resetUrl }: { resetUrl: string }) {
  return (
    <AccountEmailLayout preview="重置 Zakura 密码" title="重置密码">
      <Text style={accountEmailStyles.paragraph}>你请求重置密码。链接 1 小时内有效。</Text>
      <Text style={accountEmailStyles.paragraph}>
        <Link href={resetUrl} style={accountEmailStyles.link}>
          重置密码
        </Link>
      </Text>
      <Text style={accountEmailStyles.paragraph}>如果不是你本人操作，请忽略此邮件，密码不会被更改。</Text>
    </AccountEmailLayout>
  );
}
