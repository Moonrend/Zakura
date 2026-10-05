// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

type Provider struct {
	Ref          string   `json:"ref"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Category     string   `json:"category"`
	Capabilities []string `json:"capabilities"`
	AuthKind     string   `json:"authKind"`
}

var providers = []Provider{
	{Ref: "slack", Name: "Slack", Description: "Channels, messages, threads and search", Category: "communication", Capabilities: []string{"messages", "channels", "webhook", "oauth"}, AuthKind: "oauth2"},
	{Ref: "github", Name: "GitHub", Description: "Repositories, issues and pull requests", Category: "developer", Capabilities: []string{"issues", "pull_requests", "webhook", "oauth"}, AuthKind: "oauth2"},
	{Ref: "gitlab", Name: "GitLab", Description: "Projects, issues and merge requests", Category: "developer", Capabilities: []string{"issues", "merge_requests", "webhook", "oauth"}, AuthKind: "oauth2"},
	{Ref: "jira", Name: "Jira", Description: "Projects and issues", Category: "productivity", Capabilities: []string{"issues", "projects", "oauth"}, AuthKind: "oauth2"},
	{Ref: "linear", Name: "Linear", Description: "Teams and issues", Category: "productivity", Capabilities: []string{"issues", "teams", "webhook", "oauth"}, AuthKind: "oauth2"},
	{Ref: "notion", Name: "Notion", Description: "Pages and databases", Category: "productivity", Capabilities: []string{"pages", "databases", "oauth"}, AuthKind: "oauth2"},
	{Ref: "google-workspace", Name: "Google Workspace", Description: "Gmail, Drive, Calendar, Chat and People", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "people", "oauth"}, AuthKind: "oauth2"},
	{Ref: "microsoft-365", Name: "Microsoft 365", Description: "Outlook, OneDrive, Calendar and Teams", Category: "productivity", Capabilities: []string{"mail", "drive", "calendar", "chat", "oauth"}, AuthKind: "oauth2"},
	{Ref: "discord", Name: "Discord", Description: "Guild channels and messages", Category: "communication", Capabilities: []string{"messages", "channels", "webhook"}, AuthKind: "bot_token"},
	{Ref: "email", Name: "Email", Description: "IMAP/SMTP and inbound mail", Category: "communication", Capabilities: []string{"mail", "inbound", "outbound"}, AuthKind: "credentials"},
	{Ref: "feishu", Name: "Feishu", Description: "Chats, documents and messages", Category: "communication", Capabilities: []string{"messages", "documents", "webhook"}, AuthKind: "oauth2"},
}

func provider(ref string) (Provider, bool) {
	for _, p := range providers {
		if p.Ref == ref {
			return p, true
		}
	}
	return Provider{}, false
}
