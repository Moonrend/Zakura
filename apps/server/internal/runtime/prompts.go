// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"strings"
	"time"
)

// cloudConfig is the subset of agent.config.cloud the chat loop honours.
type cloudConfig struct {
	SystemPrompt       string
	Model              string
	ModelRouteID       string
	MaxToolRounds      int
	EnableTools        bool
	AutoMemory         bool
	AutoTitle          bool
	MaxToolResultChars int
	FollowUpMode       string
	Approvals          toolApprovalConfig
	ApprovalError      error
}

func parseCloudConfig(raw json.RawMessage) cloudConfig {
	cfg := cloudConfig{EnableTools: true, AutoMemory: true, AutoTitle: true}
	cfg.Approvals, cfg.ApprovalError = parseApprovalConfig(raw, "allow_all")
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return cfg
	}
	cloud, _ := root["cloud"].(map[string]any)
	if cloud == nil {
		return cfg
	}
	str := func(k string) string { v, _ := cloud[k].(string); return strings.TrimSpace(v) }
	cfg.SystemPrompt = str("systemPrompt")
	cfg.Model = str("model")
	cfg.ModelRouteID = str("modelRouteId")
	if n, ok := cloud["maxToolRounds"].(float64); ok && n > 0 {
		cfg.MaxToolRounds = int(n)
	}
	if n, ok := cloud["maxToolResultChars"].(float64); ok && n >= 1000 {
		cfg.MaxToolResultChars = min(int(n), 80000)
	}
	for key, dst := range map[string]*bool{"enableTools": &cfg.EnableTools, "autoMemory": &cfg.AutoMemory, "autoTitle": &cfg.AutoTitle} {
		if v, ok := cloud[key].(bool); ok {
			*dst = v
		}
	}
	if mode := str("followUpMode"); mode == queueModeSteer || mode == queueModeQueue {
		cfg.FollowUpMode = mode
	}
	return cfg
}

// continueTurnPrompt is the hidden user message written when a cancelled run
// is resumed.
const continueTurnPrompt = "请从上次中断处继续执行当前任务。已完成的步骤不要重复，从未做完的地方接着做。"

type promptMemory struct {
	ID      string
	Layer   string
	Content string
}

type promptSkill struct {
	Name        string
	Description string
	Path        string
}

type promptInput struct {
	Agent           Agent
	Space           Space
	Cloud           cloudConfig
	Now             time.Time
	Tools           map[string]bool
	ServerHints     string
	Memories        []promptMemory
	Skills          []promptSkill
	RequestedSkills []string
	Project         string
}

func buildSystemPrompt(in promptInput) string {
	has := func(name string) bool { return in.Tools[name] }
	name := in.Agent.Name
	if name == "" {
		name = "Agent"
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	lines := []string{
		"你是 Zakura Agent「" + name + "」（slug: " + in.Agent.Slug + "），运行在 Zakura 多 Agent 平台上。",
		"当前时间：" + now.UTC().Format(time.RFC3339) + "。会话持久化保存，用户可能随时从其他设备继续。",
	}
	if desc := strings.TrimSpace(in.Agent.Description); desc != "" {
		lines = append(lines, "Agent 简介："+desc)
	}
	lines = append(lines,
		"",
		"# 工作方式",
		"- 遵循「理解目标 → 收集上下文 → 行动 → 验证 → 汇报」的循环。",
		"- 需要外部信息或执行操作时调用工具，不要假装已执行、不要凭空编造事实。简单问题直接回答，不必为回答本身调用工具。",
		"- 工具失败时先阅读错误信息再调整重试；同一方法连续失败两次应换思路或向用户说明。",
		"- 多步任务先用一两句话说明计划再执行；执行过程中的关键发现要在最终回复中体现。",
		"- 破坏性或不可逆操作（删除、覆盖、对外发送）前必须先向用户确认。",
	)
	if has("search_sessions") || has("list_sessions") || has("get_messages") || has("tool_search") {
		lines = append(lines, "- 用户提到「上次 / 之前的对话 / 另一个会话」时，用 list_sessions / search_sessions 定位，再用 get_messages 取上下文，不要假装记得。")
	}
	if has("shell_exec") || has("apply_patch") {
		lines = append(lines, "- 多处改文件优先 apply_patch；shell_exec 适合运行命令、搜索代码（如 rg / grep）与验证结果。")
	}
	if has("ask_user") {
		lines = append(lines, "- 需要用户做选择、确认或提供密钥时，用 ask_user（选项卡；secret 掩码；mode=sync 等待 / async 稍后送达）。")
	}
	if has("create_routine") || has("tool_search") {
		lines = append(lines, "- 用户要求定时/周期执行时，用 create_routine 建立 Routine（cron 表达式），不要假装已设置。")
	}
	if has("delegate_agent") || has("tool_search") {
		lines = append(lines, "- 独立子任务需要另一个 Agent 的专长时，可用 delegate_agent 委派（对方看不到本对话，任务描述要自包含）。")
	}

	webSearch, webFetch := has("web_search"), has("web_fetch")
	lines = append(lines,
		"",
		"# 能力",
		"- Computer / FS / Shell: "+enabledLabel(has("shell_exec") || has("fs_read")),
		"- Desktop / Browser: "+enabledLabel(has("computer_screenshot") || has("browser_open")),
		"- Memory: "+enabledLabel(in.Agent.EnableMemory),
		"- Web Search: "+enabledLabel(webSearch),
		"- Web Fetch: "+enabledLabel(webFetch),
	)
	if has("tool_search") {
		lines = append(lines, "- 部分工具（MCP 服务器工具、会话 / Routine / 委派、桌面与浏览器控制、网页搜索 / 抓取等）不会预先列出：用 tool_search 以简短关键词搜索并加载，加载后下一轮即可调用。")
	}
	lines = append(lines, "", generativeUIPrompt)
	if hints := strings.TrimSpace(in.ServerHints); hints != "" {
		lines = append(lines, "", "# 可搜索的 MCP 服务器", hints)
	}

	if len(in.Skills) > 0 {
		lines = append(lines, "", "# 技能", "已安装以下技能（Skill）——针对特定任务写好的操作手册，这里只有名称与简介，正文需要时再读：")
		for _, skill := range in.Skills {
			entry := "- " + skill.Name
			if skill.Path != "" {
				entry += "（" + skill.Path + "）"
			}
			if d := strings.TrimSpace(skill.Description); d != "" {
				entry += "：" + truncateText(d, 200)
			}
			lines = append(lines, entry)
		}
		if has("fs_read") {
			lines = append(lines, "- 当前任务命中某个技能时，先用 fs_read 读取其 SKILL.md，再按它说的做；不要凭印象猜内容。")
		}
	}
	if len(in.RequestedSkills) > 0 {
		quoted := make([]string, 0, len(in.RequestedSkills))
		for _, s := range in.RequestedSkills {
			if s = strings.TrimSpace(s); s != "" {
				quoted = append(quoted, "「"+s+"」")
			}
		}
		if len(quoted) > 0 {
			lines = append(lines, "", "# 本回合指定技能", "用户已明确要求使用："+strings.Join(quoted, "、")+"。先逐个读取其 SKILL.md，再严格按其中的步骤完成任务；技能确实不适用于当前请求时，说明原因而不是默默忽略。")
		}
	}

	if has("shell_exec") || has("fs_read") {
		lines = append(lines,
			"",
			"# 工作区布局",
			"/workspace 是持久家目录。独立项目在 /workspace/projects/<项目名>/，一层子目录即一个项目；克隆仓库必须落到项目目录。",
			"约定目录：/workspace/projects/<名>/（项目）、/workspace/data/（输入）、/workspace/outputs/（交付）、/workspace/uploads/（用户上传）、/workspace/skills/（技能）。",
		)
		if in.Project != "" {
			lines = append(lines, "", "# 当前项目", "本会话绑定项目 `"+in.Project+"`，默认工作目录：/workspace/projects/"+in.Project+"。文件操作、shell 产物都放在这个目录内；项目指令见根目录 AGENTS.md（或 CLAUDE.md）。")
		}
	}

	lines = append(lines,
		"",
		"# 回复风格",
		"- 用简洁、准确的中文回复（用户使用其他语言时跟随用户）。",
		"- 使用 Markdown 排版；代码放代码块。",
		"- 最终回复汇总结论与关键结果，不要倾倒原始 JSON 或全部中间过程。",
	)
	if len(in.Memories) > 0 {
		lines = append(lines, "", "# 记忆", "以下是平台自动召回的相关记忆（关于用户与过往交互），供参考：")
		for _, m := range in.Memories {
			prefix := "- "
			if m.Layer != "" {
				prefix = "- [" + m.Layer + "] "
			}
			lines = append(lines, prefix+truncateText(strings.TrimSpace(m.Content), 600))
		}
		lines = append(lines, "", "记忆可能过时；与用户当前说法冲突时以用户为准。需要精确检索时可使用 memory_search；值得长期记住的新事实可用 memory_remember 保存。")
	}
	if in.Cloud.SystemPrompt != "" {
		lines = append(lines, "", "# 自定义指令（优先级最高）", in.Cloud.SystemPrompt)
	}
	return strings.Join(lines, "\n")
}

func enabledLabel(on bool) string {
	if on {
		return "已启用"
	}
	return "未启用"
}
