import { Link, Text } from "@react-email/components";
import { AccountEmailLayout, accountEmailStyles } from "./account-layout.js";

export function verifyEmailText(verifyUrl: string): string {
  return ["请验证你的 Zakura 邮箱。", "", `打开链接完成验证：${verifyUrl}`, "", "如果不是你本人操作，请忽略此邮件。"].join("\n");
}

export function VerifyEmail({ verifyUrl }: { verifyUrl: string }) {
  return (
    <AccountEmailLayout preview="验证你的 Zakura 邮箱" title="验证邮箱">
      <Text style={accountEmailStyles.paragraph}>你好，请点击下面的链接验证邮箱。链接 48 小时内有效。</Text>
      <Text style={accountEmailStyles.paragraph}>
        <Link href={verifyUrl} style={accountEmailStyles.link}>
          验证邮箱
        </Link>
      </Text>
      <Text style={accountEmailStyles.paragraph}>如果不是你本人注册，请忽略此邮件。</Text>
    </AccountEmailLayout>
  );
}
