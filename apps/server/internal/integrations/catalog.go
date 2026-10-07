// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

type PackageInfo struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Icon     string `json:"icon"`
	Accent   string `json:"accent"`
	Homepage string `json:"homepage"`
	Summary  string `json:"summary,omitempty"`
	Featured bool   `json:"featured,omitempty"`
}

type AuthFieldOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type AuthField struct {
	Key          string            `json:"key"`
	Label        string            `json:"label"`
	Type         string            `json:"type"`
	Required     bool              `json:"required,omitempty"`
	Placeholder  string            `json:"placeholder,omitempty"`
	DefaultValue string            `json:"defaultValue,omitempty"`
	Options      []AuthFieldOption `json:"options,omitempty"`
}

type AuthInfo struct {
	Kind                  string            `json:"kind"`
	Profile               string            `json:"profile"`
	ProfileLabel          string            `json:"profileLabel,omitempty"`
	DocsURL               string            `json:"docsUrl,omitempty"`
	Fields                []AuthField       `json:"fields"`
	Settings              []AuthField       `json:"settings"`
	AuthorizationEndpoint string            `json:"authorizationEndpoint,omitempty"`
	TokenEndpoint         string            `json:"tokenEndpoint,omitempty"`
	AuthorizeParams       map[string]string `json:"authorizeParams,omitempty"`
	TokenField            string            `json:"tokenField,omitempty"`
	TokenHeader           string            `json:"tokenHeader,omitempty"`
	TokenScheme           string            `json:"tokenScheme,omitempty"`
}

type Provider struct {
	Ref          string      `json:"ref"`
	Name         string      `json:"name"`
	Description  string      `json:"description"`
	Category     string      `json:"category"`
	Capabilities []string    `json:"capabilities"`
	AuthKind     string      `json:"authKind"`
	Package      PackageInfo `json:"package"`
	Auth         AuthInfo    `json:"auth"`
}

var remotePackage = PackageInfo{Slug: "agent-remote", Name: "远程 Agent", Icon: "↔", Accent: "#0f766e", Homepage: "https://chat-sdk.dev/docs"}

var providers = []Provider{
	{Ref: "slack", Name: "Slack", Description: "Channels, messages, threads and search", Category: "communication", Capabilities: []string{"messages", "channels", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "slack", Name: "Slack", Icon: "SL", Accent: "#4a154b", Homepage: "https://api.slack.com"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "slack", DocsURL: "https://api.slack.com/apps", AuthorizationEndpoint: "https://slack.com/oauth/v2/authorize", TokenEndpoint: "https://slack.com/api/oauth.v2.access", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "github", Name: "GitHub", Description: "Repositories, issues and pull requests", Category: "developer", Capabilities: []string{"issues", "pull_requests", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "github", Name: "GitHub", Icon: "GH", Accent: "#24292f", Homepage: "https://docs.github.com/en/rest"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "github", DocsURL: "https://github.com/settings/developers", AuthorizationEndpoint: "https://github.com/login/oauth/authorize", TokenEndpoint: "https://github.com/login/oauth/access_token", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "gitlab", Name: "GitLab", Description: "Projects, issues and merge requests", Category: "developer", Capabilities: []string{"issues", "merge_requests", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "gitlab", Name: "GitLab", Icon: "GL", Accent: "#fc6d26", Homepage: "https://docs.gitlab.com/ee/api/"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "gitlab", DocsURL: "https://gitlab.com/-/user_settings/applications", AuthorizationEndpoint: "https://gitlab.com/oauth/authorize", TokenEndpoint: "https://gitlab.com/oauth/token", Fields: []AuthField{{Key: "clientId", Label: "Application ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Secret", Type: "secret", Required: true}}}},
	{Ref: "jira", Name: "Jira", Description: "Projects and issues", Category: "productivity", Capabilities: []string{"issues", "projects", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "jira", Name: "Jira", Icon: "J", Accent: "#0052cc", Homepage: "https://developer.atlassian.com/cloud/jira/platform/"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "jira", DocsURL: "https://developer.atlassian.com/console/myapps/", AuthorizationEndpoint: "https://auth.atlassian.com/authorize", TokenEndpoint: "https://auth.atlassian.com/oauth/token", AuthorizeParams: map[string]string{"audience": "api.atlassian.com", "prompt": "consent"}, Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "linear", Name: "Linear", Description: "Teams and issues", Category: "productivity", Capabilities: []string{"issues", "teams", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "linear", Name: "Linear", Icon: "L", Accent: "#5e6ad2", Homepage: "https://linear.app/docs"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "linear", DocsURL: "https://linear.app/settings/api", AuthorizationEndpoint: "https://linear.app/oauth/authorize", TokenEndpoint: "https://api.linear.app/oauth/token", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "notion", Name: "Notion", Description: "Pages and databases", Category: "productivity", Capabilities: []string{"pages", "databases", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "notion", Name: "Notion", Icon: "N", Accent: "#111111", Homepage: "https://developers.notion.com"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "notion", DocsURL: "https://www.notion.so/my-integrations", AuthorizationEndpoint: "https://api.notion.com/v1/oauth/authorize", TokenEndpoint: "https://api.notion.com/v1/oauth/token", AuthorizeParams: map[string]string{"owner": "user"}, Fields: []AuthField{{Key: "clientId", Label: "OAuth Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "OAuth Client Secret", Type: "secret", Required: true}}}},
	{Ref: "google-workspace", Name: "Google Workspace", Description: "Gmail, Drive, Calendar, Chat and People", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "people", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "google-workspace", Name: "Google Workspace", Icon: "G", Accent: "#4285f4", Homepage: "https://developers.google.com/workspace"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "google-workspace", DocsURL: "https://console.cloud.google.com/apis/credentials", AuthorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", TokenEndpoint: "https://oauth2.googleapis.com/token", AuthorizeParams: map[string]string{"access_type": "offline", "prompt": "consent"}, Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true, Placeholder: "*.apps.googleusercontent.com"}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "microsoft-365", Name: "Microsoft 365", Description: "Outlook, OneDrive, Calendar and Teams", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "microsoft-365", Name: "Microsoft 365", Icon: "M", Accent: "#5e5ce6", Homepage: "https://learn.microsoft.com/graph/overview"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "microsoft-365", DocsURL: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", AuthorizationEndpoint: "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize", TokenEndpoint: "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token", Settings: []AuthField{{Key: "tenantId", Label: "Directory (tenant) ID", Type: "text", Placeholder: "common"}}, Fields: []AuthField{{Key: "clientId", Label: "Application (client) ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "discord", Name: "Discord", Description: "Guild channels and messages", Category: "communication", Capabilities: []string{"messages", "channels", "webhook"}, AuthKind: "bot_token",
		Package: PackageInfo{Slug: "discord", Name: "Discord", Icon: "D", Accent: "#5865f2", Homepage: "https://discord.com/developers/docs"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "discord", DocsURL: "https://discord.com/developers/applications", AuthorizationEndpoint: "https://discord.com/oauth2/authorize", TokenEndpoint: "https://discord.com/api/oauth2/token", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "email-smtp", Name: "SMTP", Description: "通过 SMTP 发送邮件。与 Mailgun、Resend、Amail、Bettermail 相互独立，各自单独配置。", Category: "communication", Capabilities: []string{"mail", "outbound", "inbound", "webhook"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email-smtp", Name: "SMTP", Icon: "@", Accent: "#0f766e", Homepage: "https://nodemailer.com/smtp/", Summary: "仅发信。配置 SMTP 主机与发件地址后，Agent 可调用 send_email。可选入站 Webhook 触发 Agent。", Featured: true},
		Auth:    AuthInfo{Kind: "custom", Profile: "email-smtp", ProfileLabel: "SMTP 凭据", DocsURL: "https://nodemailer.com/smtp/", Fields: []AuthField{{Key: "smtpHost", Label: "SMTP 主机", Type: "text", Required: true, Placeholder: "smtp.example.com"}, {Key: "smtpPort", Label: "SMTP 端口", Type: "text", DefaultValue: "465"}, {Key: "smtpSecure", Label: "SMTP 使用 TLS", Type: "boolean"}, {Key: "smtpUser", Label: "SMTP 用户名", Type: "text", Required: true}, {Key: "smtpPassword", Label: "SMTP 密码", Type: "secret", Required: true}}, Settings: []AuthField{{Key: "fromEmail", Label: "默认发件地址", Type: "text", Required: true, Placeholder: "agent@example.com"}, {Key: "inboundEnabled", Label: "收到邮件时触发 Agent", Type: "boolean"}, {Key: "inboundAgentId", Label: "入站目标 Agent ID", Type: "text"}, {Key: "allowedEmails", Label: "入站发件人白名单", Type: "textarea", Placeholder: "alice@example.com\n*@trusted.example.com"}, {Key: "inboundSecret", Label: "入站 Webhook 密钥", Type: "secret"}}}},
	{Ref: "email-mailgun", Name: "Mailgun", Description: "通过 Mailgun API 发送邮件。与其它邮箱连接器相互独立，各自单独配置。", Category: "communication", Capabilities: []string{"mail", "outbound", "inbound", "webhook"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email-mailgun", Name: "Mailgun", Icon: "@", Accent: "#f06b66", Homepage: "https://documentation.mailgun.com/docs/mailgun/api-reference/", Summary: "仅发信。配置 API Key 与域名后，Agent 可调用 send_email。可选入站 Webhook 触发 Agent。"},
		Auth:    AuthInfo{Kind: "custom", Profile: "email-mailgun", ProfileLabel: "Mailgun 凭据", DocsURL: "https://documentation.mailgun.com/docs/mailgun/api-reference/", Fields: []AuthField{{Key: "apiToken", Label: "Mailgun API Key", Type: "secret", Required: true}, {Key: "mailgunDomain", Label: "Mailgun 域名", Type: "text", Required: true, Placeholder: "mg.example.com"}, {Key: "mailgunRegion", Label: "Mailgun 区域", Type: "text", DefaultValue: "api"}}, Settings: []AuthField{{Key: "fromEmail", Label: "默认发件地址", Type: "text", Required: true, Placeholder: "agent@example.com"}, {Key: "inboundEnabled", Label: "收到邮件时触发 Agent", Type: "boolean"}, {Key: "inboundAgentId", Label: "入站目标 Agent ID", Type: "text"}, {Key: "allowedEmails", Label: "入站发件人白名单", Type: "textarea", Placeholder: "alice@example.com\n*@trusted.example.com"}, {Key: "inboundSecret", Label: "入站 Webhook 密钥", Type: "secret"}}}},
	{Ref: "email-resendapi", Name: "Resend", Description: "通过 Resend API 发送邮件。与 Chat SDK「Resend Email」消息通道不同；本连接器只提供发信工具。", Category: "communication", Capabilities: []string{"mail", "outbound", "inbound", "webhook"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email-resendapi", Name: "Resend", Icon: "@", Accent: "#000000", Homepage: "https://resend.com/docs/api-reference/emails/send-email", Summary: "仅发信。配置 API Key 后，Agent 可调用 send_email。可选自定义 API 地址与入站 Webhook。", Featured: true},
		Auth:    AuthInfo{Kind: "custom", Profile: "email-resendapi", ProfileLabel: "Resend 凭据", DocsURL: "https://resend.com/docs/api-reference/emails/send-email", Fields: []AuthField{{Key: "apiToken", Label: "Resend API Key", Type: "secret", Required: true}, {Key: "baseUrl", Label: "Resend API 地址", Type: "url", Placeholder: "https://api.resend.com/emails"}}, Settings: []AuthField{{Key: "fromEmail", Label: "默认发件地址", Type: "text", Required: true, Placeholder: "agent@example.com"}, {Key: "inboundEnabled", Label: "收到邮件时触发 Agent", Type: "boolean"}, {Key: "inboundAgentId", Label: "入站目标 Agent ID", Type: "text"}, {Key: "allowedEmails", Label: "入站发件人白名单", Type: "textarea", Placeholder: "alice@example.com\n*@trusted.example.com"}, {Key: "inboundSecret", Label: "入站 Webhook 密钥", Type: "secret"}}}},
	{Ref: "email-amail", Name: "Amail", Description: "通过自托管 Amail 网关发信（仅发件，不收件）。支持自定义 API 地址；与 Bettermail / SMTP 等相互独立。", Category: "communication", Capabilities: []string{"mail", "outbound"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email-amail", Name: "Amail", Icon: "@", Accent: "#0ea5e9", Homepage: "https://amail.wuyuan.dev/", Summary: "仅发信。填写 API Key 与可选自定义 API 地址后，Agent 可发送并列出已发送邮件。", Featured: true},
		Auth:    AuthInfo{Kind: "custom", Profile: "email-amail", ProfileLabel: "Amail 凭据", DocsURL: "https://amail.wuyuan.dev/", Fields: []AuthField{{Key: "apiToken", Label: "Amail API Key", Type: "secret", Required: true}, {Key: "baseUrl", Label: "Amail API 地址", Type: "url", Placeholder: "https://amail-service.192325.xyz"}, {Key: "providerId", Label: "Amail Provider ID", Type: "text", Placeholder: "auto"}}, Settings: []AuthField{{Key: "fromEmail", Label: "默认发件地址", Type: "text", Required: true, Placeholder: "agent@example.com"}}}},
	{Ref: "email-bettermail", Name: "Bettermail", Description: "从 Bettermail 主动拉取收件箱（仅收件，不发信）。与 Amail / SMTP 等相互独立，各自单独配置。", Category: "communication", Capabilities: []string{"mail", "inbound", "poll"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email-bettermail", Name: "Bettermail", Icon: "@", Accent: "#7c3aed", Homepage: "https://bettermail.dev/", Summary: "仅主动收件。配置服务地址与邮箱后，Agent 可调用 receive_emails；可选轮询触发 Agent。", Featured: true},
		Auth:    AuthInfo{Kind: "custom", Profile: "email-bettermail", ProfileLabel: "Bettermail 凭据", DocsURL: "https://bettermail.dev/", Fields: []AuthField{{Key: "apiToken", Label: "Bettermail API Token", Type: "secret"}}, Settings: []AuthField{{Key: "baseUrl", Label: "Bettermail 服务地址", Type: "url", Required: true}, {Key: "mailbox", Label: "收件邮箱", Type: "text", Required: true}, {Key: "inboundEnabled", Label: "收到邮件时触发 Agent", Type: "boolean"}, {Key: "inboundAgentId", Label: "入站目标 Agent ID", Type: "text"}, {Key: "allowedEmails", Label: "入站发件人白名单", Type: "textarea", Placeholder: "alice@example.com\n*@trusted.example.com"}, {Key: "pollIntervalSeconds", Label: "收件轮询间隔（秒）", Type: "text", DefaultValue: "30"}}}},
	{Ref: "feishu", Name: "Feishu", Description: "Chats, documents and messages", Category: "communication", Capabilities: []string{"messages", "documents", "webhook"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "feishu", Name: "飞书", Icon: "飞", Accent: "#3370ff", Homepage: "https://open.feishu.cn"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "feishu", DocsURL: "https://open.feishu.cn/app", AuthorizationEndpoint: "https://accounts.feishu.cn/open-apis/authen/v1/authorize", TokenEndpoint: "https://open.feishu.cn/open-apis/authen/v2/oauth/token", Fields: []AuthField{{Key: "clientId", Label: "App ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "App Secret", Type: "secret", Required: true}}}},

	{Ref: "remote-zakurabot", Name: "Zakura Bot", Description: "通过设备 token 连接 Zakura Bot App，支持消息、附件、卡片和工具活动。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-zakurabot", ProfileLabel: "Zakura Bot", DocsURL: "https://github.com/Moonrend/Zakura/blob/main/docs/zakurabot-channel.md", Fields: []AuthField{}}},
	{Ref: "remote-slack", Name: "Slack", Description: "接入 Slack 私聊、提及和已订阅线程。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-slack", ProfileLabel: "Slack 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/slack", Fields: []AuthField{{Key: "botToken", Label: "Bot Token", Type: "secret", Required: true}, {Key: "signingSecret", Label: "Signing Secret", Type: "secret", Required: true}, {Key: "appToken", Label: "App Token（Socket Mode 可选）", Type: "secret"}, {Key: "userName", Label: "机器人名称", Type: "text"}}}},
	{Ref: "remote-teams", Name: "Microsoft Teams", Description: "接入 Teams 私聊与团队消息。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-teams", ProfileLabel: "Teams 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/teams", Fields: []AuthField{{Key: "appId", Label: "Microsoft App ID", Type: "text", Required: true}, {Key: "appPassword", Label: "Microsoft App Password", Type: "secret", Required: true}, {Key: "appTenantId", Label: "Tenant ID", Type: "text"}, {Key: "appType", Label: "App Type", Type: "select", Options: []AuthFieldOption{{Value: "MultiTenant", Label: "MultiTenant"}, {Value: "SingleTenant", Label: "SingleTenant"}}}}}},
	{Ref: "remote-gchat", Name: "Google Chat", Description: "接入 Google Chat Space 与私聊。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-gchat", ProfileLabel: "Google Chat 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/gchat", Fields: []AuthField{{Key: "credentials", Label: "Service Account JSON", Type: "textarea", Required: true}, {Key: "projectId", Label: "Google Cloud Project ID", Type: "text"}, {Key: "webhookSecret", Label: "Webhook Secret", Type: "secret"}}}},
	{Ref: "remote-discord", Name: "Discord", Description: "接入 Discord 私聊、提及和线程。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-discord", ProfileLabel: "Discord 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/discord", Fields: []AuthField{{Key: "botToken", Label: "Bot Token", Type: "secret", Required: true}, {Key: "applicationId", Label: "Application ID", Type: "text"}, {Key: "publicKey", Label: "Public Key", Type: "text"}}}},
	{Ref: "remote-telegram", Name: "Telegram", Description: "接入 Telegram Bot 私聊与群组提及。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-telegram", ProfileLabel: "Telegram 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/telegram", Fields: []AuthField{{Key: "botToken", Label: "Bot Token", Type: "secret", Required: true}, {Key: "secretToken", Label: "Webhook Secret Token", Type: "secret"}, {Key: "mode", Label: "接收模式", Type: "select", DefaultValue: "webhook", Options: []AuthFieldOption{{Value: "webhook", Label: "Webhook（推荐）"}, {Value: "polling", Label: "轮询"}, {Value: "auto", Label: "自动"}}}}}},
	{Ref: "remote-github", Name: "GitHub", Description: "接入 Issue 与 Pull Request 评论线程。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-github", ProfileLabel: "GitHub 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/github", Fields: []AuthField{{Key: "token", Label: "Personal Access Token", Type: "secret"}, {Key: "appId", Label: "GitHub App ID", Type: "text"}, {Key: "installationId", Label: "Installation ID", Type: "text"}, {Key: "privateKey", Label: "Private Key", Type: "textarea"}, {Key: "webhookSecret", Label: "Webhook Secret", Type: "secret"}}}},
	{Ref: "remote-linear", Name: "Linear", Description: "接入 Linear Issue 评论与 Agent session。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-linear", ProfileLabel: "Linear 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/linear", Fields: []AuthField{{Key: "apiKey", Label: "API Key", Type: "secret"}, {Key: "clientId", Label: "OAuth Client ID", Type: "text"}, {Key: "clientSecret", Label: "OAuth Client Secret", Type: "secret"}, {Key: "webhookSecret", Label: "Webhook Secret", Type: "secret"}}}},
	{Ref: "remote-whatsapp", Name: "WhatsApp", Description: "接入 WhatsApp Business 消息。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-whatsapp", ProfileLabel: "WhatsApp 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/whatsapp", Fields: []AuthField{{Key: "accessToken", Label: "Access Token", Type: "secret", Required: true}, {Key: "phoneNumberId", Label: "Phone Number ID", Type: "text", Required: true}, {Key: "appSecret", Label: "App Secret", Type: "secret", Required: true}, {Key: "verifyToken", Label: "Verify Token", Type: "secret", Required: true}}}},
	{Ref: "remote-twilio", Name: "Twilio", Description: "接入 Twilio SMS/MMS 消息。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-twilio", ProfileLabel: "Twilio 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/twilio", Fields: []AuthField{{Key: "accountSid", Label: "Account SID", Type: "text", Required: true}, {Key: "authToken", Label: "Auth Token", Type: "secret", Required: true}, {Key: "phoneNumber", Label: "发送号码", Type: "text", Required: true}}}},
	{Ref: "remote-messenger", Name: "Messenger", Description: "接入 Facebook Messenger。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-messenger", ProfileLabel: "Messenger 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/official/messenger", Fields: []AuthField{{Key: "pageAccessToken", Label: "Page Access Token", Type: "secret", Required: true}, {Key: "appSecret", Label: "App Secret", Type: "secret", Required: true}, {Key: "verifyToken", Label: "Verify Token", Type: "secret", Required: true}}}},
	{Ref: "remote-resend", Name: "Resend Email", Description: "通过 Resend Chat SDK Adapter 接收邮件并在同一线程回复。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-resend", ProfileLabel: "Resend Chat SDK", DocsURL: "https://resend.com/docs/chat-sdk", Fields: []AuthField{{Key: "apiKey", Label: "Resend API Key", Type: "secret", Required: true}, {Key: "webhookSecret", Label: "Webhook Signing Secret", Type: "secret", Required: true}, {Key: "fromAddress", Label: "发件地址", Type: "text", Required: true}, {Key: "fromName", Label: "发件人名称", Type: "text"}}}},
	{Ref: "remote-webex", Name: "Webex", Description: "通过 Chat SDK 接入 Webex Space 消息。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-webex", ProfileLabel: "Webex 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/community/webex", Fields: []AuthField{{Key: "botToken", Label: "Bot Token", Type: "secret", Required: true}, {Key: "webhookSecret", Label: "Webhook Secret", Type: "secret"}, {Key: "baseUrl", Label: "API 地址", Type: "url"}, {Key: "userName", Label: "机器人名称", Type: "text"}}}},
	{Ref: "remote-mattermost", Name: "Mattermost", Description: "通过 Chat SDK 接入 Mattermost 频道和线程。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-mattermost", ProfileLabel: "Mattermost 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/community/mattermost", Fields: []AuthField{{Key: "baseUrl", Label: "Mattermost 地址", Type: "url", Required: true}, {Key: "botToken", Label: "Bot Token", Type: "secret", Required: true}, {Key: "callbackUrl", Label: "Callback URL", Type: "url"}}}},
	{Ref: "remote-weixin", Name: "微信 Weixin", Description: "通过 Chat SDK Weixin Adapter 接收一对一消息。", Category: "communication", Capabilities: []string{}, AuthKind: "custom",
		Package: remotePackage, Auth: AuthInfo{Kind: "custom", Profile: "remote-weixin", ProfileLabel: "微信 Weixin 远程 Agent", DocsURL: "https://chat-sdk.dev/adapters/community/weixin", Fields: []AuthField{{Key: "accountId", Label: "Account ID", Type: "text", Required: true}, {Key: "token", Label: "Bot Token", Type: "secret", Required: true}, {Key: "baseUrl", Label: "API 地址", Type: "url"}}}},
}

func provider(ref string) (Provider, bool) {
	if ref == "email" {
		ref = "email-smtp"
	}
	for _, p := range providers {
		if p.Ref == ref {
			return p, true
		}
	}
	return Provider{}, false
}
