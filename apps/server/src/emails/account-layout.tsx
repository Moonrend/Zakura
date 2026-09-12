import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";

const main = {
  backgroundColor: "#f6f6f6",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "40px auto",
  padding: "32px 28px",
  maxWidth: "560px",
  borderRadius: "8px",
};

const heading = {
  fontSize: "20px",
  fontWeight: "600" as const,
  color: "#111111",
  margin: "0 0 24px",
};

const paragraph = {
  fontSize: "15px",
  lineHeight: "1.7",
  color: "#222222",
  margin: "0 0 16px",
};

const link = {
  color: "#0b57d0",
  textDecoration: "underline",
};

const hr = {
  borderColor: "#eaeaea",
  margin: "28px 0 16px",
};

const footer = {
  fontSize: "12px",
  color: "#888888",
  margin: "0",
  lineHeight: "1.5",
};

export function AccountEmailLayout(props: {
  preview: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Html lang="zh-CN">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>{props.title}</Heading>
          <Section>{props.children}</Section>
          <Hr style={hr} />
          <Text style={footer}>此邮件由系统自动发送，请勿直接回复。</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const accountEmailStyles = { paragraph, link };
