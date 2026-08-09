import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

const IASP_URL = "https://www.iasp.info/suicidalthoughts/";

/** 「Zakura支持资源」纯文本正文（对齐 X 支持信函结构，资源改适中国大陆） */
export function crisisSupportText(): string {
  return [
    "你好！",
    "",
    "之所以与你联系，是因为我们担心你可能正经历一段艰难时期。",
    "",
    "如果你有过抑郁、自残或自杀的念头，我们鼓励你联系他人寻求帮助。可以提供帮助：",
    "",
    "中国大陆：拨打希望24热线 400-161-9995，或北京心理危机研究与干预中心热线 010-82951332。",
    "也可拨打公共卫生热线 12320，咨询你所在地区的心理援助资源。",
    `全球范围：如需查找你所在地区的帮助热线或资源，请访问国际自杀预防协会：${IASP_URL}`,
    "",
    "处境艰难的时候，需要找人倾诉的时候，不妨和专业人士聊聊，他们能够给予你慰藉，能够帮助你应对你眼下的处境。",
    "",
    "请你宽心明了，因为很多人在乎你，所以你并不孤单。",
    "",
    "珍重，",
    "",
    "Zakura 支持",
  ].join("\n");
}

export function CrisisSupportEmail() {
  return (
    <Html lang="zh-CN">
      <Head />
      <Preview>Zakura支持资源</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Zakura支持资源</Heading>
          <Section style={section}>
            <Text style={paragraph}>你好！</Text>
            <Text style={paragraph}>
              之所以与你联系，是因为我们担心你可能正经历一段艰难时期。
            </Text>
            <Text style={paragraph}>
              如果你有过抑郁、自残或自杀的念头，我们鼓励你联系他人寻求帮助。可以提供帮助：
            </Text>
            <Text style={paragraph}>
              <strong>中国大陆：</strong>
              拨打希望24热线{" "}
              <Link href="tel:4001619995" style={link}>
                400-161-9995
              </Link>
              ，或北京心理危机研究与干预中心热线{" "}
              <Link href="tel:01082951332" style={link}>
                010-82951332
              </Link>
              。也可拨打公共卫生热线{" "}
              <Link href="tel:12320" style={link}>
                12320
              </Link>
              ，咨询你所在地区的心理援助资源。
            </Text>
            <Text style={paragraph}>
              <strong>全球范围：</strong>
              如需查找你所在地区的帮助热线或资源，请访问
              <Link href={IASP_URL} style={link}>
                国际自杀预防协会
              </Link>
              。
            </Text>
            <Text style={paragraph}>
              处境艰难的时候，需要找人倾诉的时候，不妨和专业人士聊聊，他们能够给予你慰藉，能够帮助你应对你眼下的处境。
            </Text>
            <Text style={paragraph}>
              请你宽心明了，因为很多人在乎你，所以你并不孤单。
            </Text>
            <Text style={paragraph}>珍重，</Text>
            <Text style={signoff}>Zakura 支持</Text>
          </Section>
          <Hr style={hr} />
          <Text style={footer}>此邮件由系统自动发送，请勿直接回复。</Text>
        </Container>
      </Body>
    </Html>
  );
}

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

const section = {
  margin: "0",
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

const signoff = {
  ...paragraph,
  marginBottom: "0",
  fontWeight: "600" as const,
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
