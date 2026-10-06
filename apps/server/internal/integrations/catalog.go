// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

type PackageInfo struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Icon     string `json:"icon"`
	Accent   string `json:"accent"`
	Homepage string `json:"homepage"`
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
	Kind         string      `json:"kind"`
	Profile      string      `json:"profile"`
	ProfileLabel string      `json:"profileLabel,omitempty"`
	DocsURL      string      `json:"docsUrl,omitempty"`
	Fields       []AuthField `json:"fields"`
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
		Auth:    AuthInfo{Kind: "oauth2", Profile: "slack", DocsURL: "https://api.slack.com/apps", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "github", Name: "GitHub", Description: "Repositories, issues and pull requests", Category: "developer", Capabilities: []string{"issues", "pull_requests", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "github", Name: "GitHub", Icon: "GH", Accent: "#24292f", Homepage: "https://docs.github.com/en/rest"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "github", DocsURL: "https://github.com/settings/developers", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "gitlab", Name: "GitLab", Description: "Projects, issues and merge requests", Category: "developer", Capabilities: []string{"issues", "merge_requests", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "gitlab", Name: "GitLab", Icon: "GL", Accent: "#fc6d26", Homepage: "https://docs.gitlab.com/ee/api/"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "gitlab", DocsURL: "https://gitlab.com/-/user_settings/applications", Fields: []AuthField{{Key: "clientId", Label: "Application ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Secret", Type: "secret", Required: true}}}},
	{Ref: "jira", Name: "Jira", Description: "Projects and issues", Category: "productivity", Capabilities: []string{"issues", "projects", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "jira", Name: "Jira", Icon: "J", Accent: "#0052cc", Homepage: "https://developer.atlassian.com/cloud/jira/platform/"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "jira", DocsURL: "https://developer.atlassian.com/console/myapps/", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "linear", Name: "Linear", Description: "Teams and issues", Category: "productivity", Capabilities: []string{"issues", "teams", "webhook", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "linear", Name: "Linear", Icon: "L", Accent: "#5e6ad2", Homepage: "https://linear.app/docs"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "linear", DocsURL: "https://linear.app/settings/api", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "notion", Name: "Notion", Description: "Pages and databases", Category: "productivity", Capabilities: []string{"pages", "databases", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "notion", Name: "Notion", Icon: "N", Accent: "#111111", Homepage: "https://developers.notion.com"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "notion", DocsURL: "https://www.notion.so/my-integrations", Fields: []AuthField{{Key: "clientId", Label: "OAuth Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "OAuth Client Secret", Type: "secret", Required: true}}}},
	{Ref: "google-workspace", Name: "Google Workspace", Description: "Gmail, Drive, Calendar, Chat and People", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "people", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "google-workspace", Name: "Google Workspace", Icon: "G", Accent: "#4285f4", Homepage: "https://developers.google.com/workspace"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "google-workspace", DocsURL: "https://console.cloud.google.com/apis/credentials", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true, Placeholder: "*.apps.googleusercontent.com"}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "microsoft-365", Name: "Microsoft 365", Description: "Outlook, OneDrive, Calendar and Teams", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "oauth"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "microsoft-365", Name: "Microsoft 365", Icon: "M", Accent: "#5e5ce6", Homepage: "https://learn.microsoft.com/graph/overview"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "microsoft-365", DocsURL: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", Fields: []AuthField{{Key: "clientId", Label: "Application (client) ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "discord", Name: "Discord", Description: "Guild channels and messages", Category: "communication", Capabilities: []string{"messages", "channels", "webhook"}, AuthKind: "bot_token",
		Package: PackageInfo{Slug: "discord", Name: "Discord", Icon: "D", Accent: "#5865f2", Homepage: "https://discord.com/developers/docs"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "discord", DocsURL: "https://discord.com/developers/applications", Fields: []AuthField{{Key: "clientId", Label: "Client ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "Client Secret", Type: "secret", Required: true}}}},
	{Ref: "email", Name: "Email", Description: "IMAP/SMTP and inbound mail", Category: "communication", Capabilities: []string{"mail", "inbound", "outbound"}, AuthKind: "credentials",
		Package: PackageInfo{Slug: "email", Name: "Email", Icon: "@", Accent: "#0f766e", Homepage: "https://nodemailer.com/smtp/"},
		Auth:    AuthInfo{Kind: "custom", Profile: "email", DocsURL: "https://nodemailer.com/smtp/", Fields: []AuthField{}}},
	{Ref: "feishu", Name: "Feishu", Description: "Chats, documents and messages", Category: "communication", Capabilities: []string{"messages", "documents", "webhook"}, AuthKind: "oauth2",
		Package: PackageInfo{Slug: "feishu", Name: "飞书", Icon: "飞", Accent: "#3370ff", Homepage: "https://open.feishu.cn"},
		Auth:    AuthInfo{Kind: "oauth2", Profile: "feishu", DocsURL: "https://open.feishu.cn/app", Fields: []AuthField{{Key: "clientId", Label: "App ID", Type: "text", Required: true}, {Key: "clientSecret", Label: "App Secret", Type: "secret", Required: true}}}},

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
	for _, p := range providers {
		if p.Ref == ref {
			return p, true
		}
	}
	return Provider{}, false
}
