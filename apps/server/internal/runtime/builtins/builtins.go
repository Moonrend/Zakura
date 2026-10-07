// SPDX-License-Identifier: AGPL-3.0-or-later
package builtins

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"strings"
)

//go:embed skills/*/SKILL.md
var skillsFS embed.FS

type builtinSkillDef struct {
	Name        string
	Title       string
	Description string
	Recommended bool
	Requires    []string
	Tags        []string
}

type Definition = builtinSkillDef

var builtinSkills = []builtinSkillDef{
	{
		Name:        "find-skills",
		Title:       "查找并安装技能",
		Description: "在用户想要某项你尚不具备的能力时，搜索并安装 Agent Skill。当用户问「你能不能做 X」「有没有做 X 的技能」「怎么做 X」，或表达希望扩展你的能力、提到某个专门领域（设计、测试、部署、文档、数据处理等）时，务必使用本技能，即使他们没有说出「技能」两个字。",
		Recommended: true,
		Tags:        []string{"元技能", "技能管理"},
	},
	{
		Name:        "skill-creator",
		Title:       "编写技能",
		Description: "创建新技能、改进已有技能。当用户说「把这个流程写成技能」「做一个 X 技能」「优化这个技能的触发」，或者你发现某套做法值得沉淀复用时使用。也用于修复技能不触发、描述写得不好的问题。",
		Recommended: true,
		Tags:        []string{"元技能", "技能管理"},
	},
	{
		Name:        "browser-automation",
		Title:       "浏览器自动化",
		Description: "用工作区内置 Chromium 完成网页操作：登录、填表、抓取动态渲染的内容、点击流程、截图取证。当任务涉及「打开网页」「在某网站上操作」「看看这个页面显示什么」「帮我登录/提交表单」「网页截图」时使用。需要网页内容但不需要交互时，优先用 web_fetch 而不是本技能。",
		Recommended: true,
		Requires:    []string{"browser"},
		Tags:        []string{"浏览器", "自动化"},
	},
	{
		Name:        "computer-automation",
		Title:       "桌面操作",
		Description: "使用容器工作区的无障碍 snapshot 和 ref 操作完整桌面，支持截图、点击、拖动、键盘输入和滚动。需要操作浏览器外的窗口时使用；仅网页交互优先用 browser-automation。",
		Recommended: true,
		Requires:    []string{"computer"},
		Tags:        []string{"电脑", "桌面", "截图"},
	},
	{
		Name:        "web-research",
		Title:       "网络调研",
		Description: "在网上查证事实、对比方案、追踪最新信息，并给出带出处的结论。当用户问「最新的 X 是什么」「对比一下 A 和 B」「查一下 X 的资料」「这个说法对吗」，或任何你知识里没有、可能已经过时的问题时使用。",
		Recommended: true,
		Requires:    []string{"web"},
		Tags:        []string{"调研", "网页"},
	},
	{
		Name:        "workspace-projects",
		Title:       "工作区与代码工程",
		Description: "在云端工作区里建项目、写代码、装依赖、跑脚本和测试。当任务涉及写程序、跑命令、处理数据文件、搭建可运行的东西时使用。也覆盖工作区文件的组织约定和排障方法。",
		Recommended: true,
		Requires:    []string{"computer"},
		Tags:        []string{"工作区", "开发"},
	},
	{
		Name:        "deliver-artifacts",
		Title:       "交付产物与预览",
		Description: "把工作区里的成果交到用户手上：生成文件下载链接、暴露端口做在线预览、整理交付清单。当你做完了东西需要用户查看、下载、试用，或用户说「发给我」「让我看看效果」「能访问吗」时使用。",
		Recommended: true,
		Requires:    []string{"computer"},
		Tags:        []string{"交付", "分享"},
	},
	{
		Name:        "subagent-orchestration",
		Title:       "子代理与任务编排",
		Description: "把大任务拆成可并行的子任务，用子代理并发执行，或委派给其他 Agent。当任务涉及大量独立的探索/调研/改造工作、需要读很多材料但只要结论、或者某部分工作明显属于另一个 Agent 的职责时使用。",
		Recommended: false,
		Tags:        []string{"编排", "子代理"},
	},
	{
		Name:        "memory-curation",
		Title:       "记忆整理",
		Description: "维护关于用户和长期任务的记忆：该记什么、不该记什么、如何检索和更新。当用户说「记住这个」「你怎么忘了」「别再记这个了」，或你发现自己在反复询问已经知道的信息时使用。",
		Recommended: false,
		Requires:    []string{"memory"},
		Tags:        []string{"记忆"},
	},
	{
		Name:        "google-workspace",
		Title:       "Google Workspace",
		Description: "使用已连接的 Gmail、Drive、Calendar、People 和 Chat MCP 完成跨应用工作。当用户要求处理 Google 邮件、日历、云盘、联系人、会议安排或 Workspace 协作时使用。",
		Recommended: false,
		Tags:        []string{"Google", "邮件", "日历", "云盘", "协作"},
	},
	{
		Name:        "microsoft-365",
		Title:       "Microsoft 365",
		Description: "使用已连接的 Outlook、OneDrive、SharePoint、Teams 与 Microsoft Graph 完成 Microsoft 365 工作。当用户提到微软邮箱、会议、文件、Teams、组织目录或 Entra 账号时使用。",
		Recommended: false,
		Tags:        []string{"Microsoft", "Outlook", "Teams", "OneDrive", "Graph"},
	},
	{
		Name:        "github",
		Title:       "GitHub",
		Description: "使用已连接的 GitHub 仓库、Issues、PR 与搜索工具完成开发协作。当用户要求查仓库、开 Issue、审 PR 或搜代码时使用。",
		Recommended: false,
		Tags:        []string{"GitHub", "开发", "PR", "Issue"},
	},
	{
		Name:        "slack",
		Title:       "Slack",
		Description: "使用已连接的 Slack 频道、消息与用户工具完成工作区沟通。当用户要求发消息、查频道历史或查找同事时使用。",
		Recommended: false,
		Tags:        []string{"Slack", "协作", "消息"},
	},
	{
		Name:        "notion",
		Title:       "Notion",
		Description: "使用已连接的 Notion 页面、数据库与用户工具完成知识库工作。当用户要求搜索 Notion、读写页面或查询数据库时使用。",
		Recommended: false,
		Tags:        []string{"Notion", "知识库", "文档"},
	},
	{
		Name:        "linear",
		Title:       "Linear",
		Description: "使用已连接的 Linear Issues、Projects 与 Teams 工具。当用户要求查 Issue、开单或看项目进度时使用。",
		Recommended: false,
		Tags:        []string{"Linear", "Issue", "项目管理"},
	},
	{
		Name:        "feishu",
		Title:       "飞书",
		Description: "使用已连接的飞书文档、多维表格与消息工具。当用户提到飞书文档、表格、群聊或发消息时使用。",
		Recommended: false,
		Tags:        []string{"飞书", "文档", "消息"},
	},
	{
		Name:        "discord",
		Title:       "Discord",
		Description: "使用已连接的 Discord 服务器与用户资料工具。当用户要求查看所在服务器或 Discord 账号信息时使用。",
		Recommended: false,
		Tags:        []string{"Discord", "社区"},
	},
	{
		Name:        "gitlab",
		Title:       "GitLab",
		Description: "使用已连接的 GitLab 项目与 Issues 工具。当用户要求查 GitLab 项目或开 Issue 时使用。",
		Recommended: false,
		Tags:        []string{"GitLab", "开发", "Issue"},
	},
	{
		Name:        "jira",
		Title:       "Jira",
		Description: "使用已连接的 Jira Issues 与 Projects 工具。当用户要求用 JQL 查单、开 Issue 或看项目时使用。",
		Recommended: false,
		Tags:        []string{"Jira", "Issue", "项目管理"},
	},
}

func All() []Definition { return builtinSkills }

func Get(name string) (Definition, bool) {
	for _, d := range builtinSkills {
		if d.Name == name {
			return d, true
		}
	}
	return builtinSkillDef{}, false
}

func Recommended() []Definition {
	out := make([]Definition, 0, 7)
	for _, d := range builtinSkills {
		if d.Recommended {
			out = append(out, d)
		}
	}
	return out
}

func builtinManifest(d builtinSkillDef) string {
	raw, err := skillsFS.ReadFile("skills/" + d.Name + "/SKILL.md")
	if err != nil {
		panic("builtins: missing manifest for " + d.Name)
	}
	return string(raw)
}

func (d builtinSkillDef) Manifest() string { return builtinManifest(d) }

func builtinBody(d builtinSkillDef) string {
	return strings.TrimSpace(manifestBody(builtinManifest(d)))
}

func manifestBody(manifest string) string {
	text := strings.TrimPrefix(manifest, "\ufeff")
	if !strings.HasPrefix(text, "---") {
		return text
	}
	rest := text[3:]
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[i+1:]
	} else {
		return ""
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return ""
	}
	return strings.TrimLeft(rest[end+4:], "\r\n")
}

func builtinVersion(d builtinSkillDef) string {
	payload := marshalCompact([]any{d.Name, d.Description, builtinBody(d), []any{}})
	sum := sha256.Sum256(payload)
	return "builtin-" + hex.EncodeToString(sum[:])[:12]
}

func (d builtinSkillDef) Version() string { return builtinVersion(d) }

func marshalCompact(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic("builtins: encode version payload: " + err.Error())
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}
