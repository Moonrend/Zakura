// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"encoding/json"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

type Recipe struct {
	ID         string     `json:"id"`
	Definition Definition `json:"definition"`
}

// Recipes returns newly allocated declarative definitions, never shared mutable
// catalog objects. They deliberately leave concrete agents to the caller.
func Recipes() []Recipe {
	return []Recipe{
		{ID: "go-feature", Definition: goFeature()},
		{ID: "localized-docs", Definition: localizedDocs()},
		{ID: "regression-repair", Definition: regressionRepair()},
	}
}

func defaultJSON(value any) json.RawMessage { raw, _ := json.Marshal(value); return raw }
func requiredPath(id, path string) mission.CheckSpec {
	return mission.CheckSpec{ID: id, Kind: "path_exists", Path: path, Required: true}
}
func requiredJSON(id, path string) mission.CheckSpec {
	return mission.CheckSpec{ID: id, Kind: "json_valid", Path: path, Required: true}
}
func goTests() mission.CheckSpec {
	return mission.CheckSpec{ID: "go-tests", Kind: "command", Title: "Go tests pass", Command: []string{"go", "test", "./..."}, TimeoutSeconds: 300, Required: true}
}
func recipeConfig() mission.Config {
	return mission.Config{Budget: mission.Budget{MaxTokens: 200000, MaxModelCalls: 100, MaxToolCalls: 200, MaxWallSeconds: 7200, MaxConcurrent: 3}, RequireReview: true, ExternalEffects: "deny", MaxTasks: 50}
}

func goFeature() Definition {
	return Definition{
		Name: "Go 功能交付", Description: "先确定接口与验收，再在独立分支实现，最后从依赖产物完成测试与交付说明。适用于已有 Go 工作区。", ProjectName: "交付 {{param.feature}}", Goal: "在现有 Go 项目实现 {{param.feature}}：{{param.requirements}}。所有 Go 测试通过，提交可供人工评审的接口说明和交付报告。",
		Parameters: []Parameter{
			{Name: "feature", Title: "功能名称", Type: "string", Required: true, MinLength: 1, MaxLength: 80},
			{Name: "requirements", Title: "具体需求", Type: "string", Required: true, MinLength: 10, MaxLength: 10000},
			{Name: "source", Title: "允许修改的源码目录", Type: "path", Required: true, Default: defaultJSON("internal/feature")},
			{Name: "deliverables", Title: "交付产物目录", Type: "path", Required: true, Default: defaultJSON("docs/delivery")},
		},
		Tasks: []Task{
			{Key: "design", Title: "确定接口和验收", Prompt: "针对 {{param.feature}} 和需求 {{param.requirements}} 检查现有架构，在 {{param.deliverables}}/design.json 记录接口、数据约束、实现边界和具体验收方案。不要修改实现代码。", AgentRole: "architect", Writes: []string{"{{param.deliverables}}/design.json"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredJSON("design", "{{param.deliverables}}/design.json")}},
			{Key: "implement", Title: "实现功能并验证", Prompt: "读取依赖任务的 design.json，实现 {{param.feature}}。仅修改 {{param.source}} 下的实现和测试，补齐错误处理并运行 go test ./...。需求：{{param.requirements}}。", AgentRole: "developer", DependsOn: []Dependency{{Task: "design"}}, Writes: []string{"{{param.source}}/**"}, MaxAttempts: 4, Checks: []mission.CheckSpec{requiredPath("source", "{{param.source}}"), goTests()}},
			{Key: "handoff", Title: "独立验收与交付报告", Prompt: "检查依赖分支中的真实实现与 design.json，运行完整 Go 测试。在 {{param.deliverables}}/report.json 记录验证证据、限制、使用方式和仍需人工确认的事项。不要凭空填写通过结果。", AgentRole: "reviewer", DependsOn: []Dependency{{Task: "implement"}}, Writes: []string{"{{param.deliverables}}/report.json"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredJSON("report", "{{param.deliverables}}/report.json"), goTests()}},
		}, Config: recipeConfig(),
	}
}

func localizedDocs() Definition {
	return Definition{
		Name: "多语言文档交付", Description: "按语言展开翻译与校对任务，每个校对任务只读取同语言翻译分支，最后汇总所有校对产物。", ProjectName: "{{param.product}} 多语言文档", Goal: "基于 {{param.source}} 为 {{param.product}} 提供中文、英文和日文说明，保留命令/API 标识符并交付逐语言质量报告。",
		Parameters: []Parameter{{Name: "product", Title: "产品名称", Type: "string", Required: true, MinLength: 1, MaxLength: 100}, {Name: "source", Title: "已有说明文件", Type: "path", Required: true, Default: defaultJSON("README.md")}, {Name: "output", Title: "输出目录", Type: "path", Required: true, Default: defaultJSON("docs/locales")}, {Name: "includeJapanese", Title: "包含日文", Type: "bool", Default: defaultJSON(true)}},
		Tasks: []Task{
			{Key: "translate", Title: "编写 {{matrix.locale}} 说明", Prompt: "读取 {{param.source}}，为 {{param.product}} 编写 {{matrix.locale}} 说明到 {{param.output}}/{{matrix.locale}}.md。保留真实命令和接口名称，确保示例来自当前项目。", AgentRole: "writer", Matrix: map[string][]string{"locale": {"zh-CN", "en-US", "ja-JP"}}, When: japaneseCondition(), Writes: []string{"{{param.output}}/{{matrix.locale}}.md"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredPath("document", "{{param.output}}/{{matrix.locale}}.md")}},
			{Key: "proofread", Title: "校对 {{matrix.locale}} 说明", Prompt: "逐项对照 {{param.source}} 审核 {{param.output}}/{{matrix.locale}}.md，修正遗漏、错误示例和术语。在 {{param.output}}/{{matrix.locale}}.review.json 记录逐项核对证据。", AgentRole: "reviewer", Matrix: map[string][]string{"locale": {"zh-CN", "en-US", "ja-JP"}}, When: japaneseCondition(), DependsOn: []Dependency{{Task: "translate", MatchAxes: []string{"locale"}}}, Writes: []string{"{{param.output}}/{{matrix.locale}}.md", "{{param.output}}/{{matrix.locale}}.review.json"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredPath("document", "{{param.output}}/{{matrix.locale}}.md"), requiredJSON("review", "{{param.output}}/{{matrix.locale}}.review.json")}},
			{Key: "index", Title: "汇总已验收的语言", Prompt: "读取所有依赖任务的文档与校对 JSON，在 {{param.output}}/index.json 生成实际可用语言列表、文档路径和校对摘要。仅包含真实交付的语言。", AgentRole: "writer", DependsOn: []Dependency{{Task: "proofread"}}, Writes: []string{"{{param.output}}/index.json"}, MaxAttempts: 2, Checks: []mission.CheckSpec{requiredJSON("index", "{{param.output}}/index.json")}},
		}, Config: recipeConfig(),
	}
}

func japaneseCondition() *Condition {
	return &Condition{Any: []Condition{{Ref: "matrix.locale", Op: "ne", Value: defaultJSON("ja-JP")}, {Ref: "param.includeJapanese", Op: "eq", Value: defaultJSON(true)}}}
}

func regressionRepair() Definition {
	return Definition{
		Name: "Go 回归修复", Description: "从诊断证据到修复，再由独立任务检查回归测试和交付报告。", ProjectName: "修复 {{param.issue}}", Goal: "定位并修复 Go 项目问题 {{param.issue}}：{{param.symptoms}}。加入能够区分修复前后的回归测试，完整 Go 测试通过。",
		Parameters: []Parameter{{Name: "issue", Title: "问题名称", Type: "string", Required: true, MinLength: 1, MaxLength: 100}, {Name: "symptoms", Title: "复现与预期行为", Type: "string", Required: true, MinLength: 10, MaxLength: 10000}, {Name: "source", Title: "允许修改的源码目录", Type: "path", Required: true, Default: defaultJSON("internal")}, {Name: "evidence", Title: "证据目录", Type: "path", Required: true, Default: defaultJSON("docs/regression")}},
		Tasks: []Task{
			{Key: "diagnose", Title: "复现和定位", Prompt: "依据 {{param.symptoms}} 检查当前源码和测试，在 {{param.evidence}}/diagnosis.json 记录复现步骤、真实失败输出、根因证据和预期修复边界。暂不修改源码。", AgentRole: "investigator", Writes: []string{"{{param.evidence}}/diagnosis.json"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredJSON("diagnosis", "{{param.evidence}}/diagnosis.json")}},
			{Key: "repair", Title: "修复并加入回归测试", Prompt: "读取 diagnosis.json，修复 {{param.issue}}，在 {{param.source}} 范围加入有意义的回归测试。确认测试能够区分原问题，并运行 go test ./...。", AgentRole: "developer", DependsOn: []Dependency{{Task: "diagnose"}}, Writes: []string{"{{param.source}}/**"}, MaxAttempts: 4, Checks: []mission.CheckSpec{goTests()}},
			{Key: "verify", Title: "独立验证修复", Prompt: "基于依赖的修复快照审核差异，重新验证复现步骤和回归测试。在 {{param.evidence}}/verification.json 记录实际证据、影响面和限制。不能用未经执行的测试作为证据。", AgentRole: "reviewer", DependsOn: []Dependency{{Task: "repair"}}, Writes: []string{"{{param.evidence}}/verification.json"}, MaxAttempts: 3, Checks: []mission.CheckSpec{requiredJSON("verification", "{{param.evidence}}/verification.json"), goTests()}},
		}, Config: recipeConfig(),
	}
}
