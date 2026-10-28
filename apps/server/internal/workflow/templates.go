// SPDX-License-Identifier: AGPL-3.0-or-later
package workflow

// Template definitions are returned freshly allocated, so callers may edit a
// sample without changing global state or another tenant's response.
type Template struct {
	ID          string  `json:"id"`
	Description string  `json:"description"`
	Request     Request `json:"request"`
}

func Templates() []Template {
	return []Template{
		{ID: "research", Description: "并行检索、事实核验与综合报告", Request: Request{
			Definition: Definition{Version: 1, Name: "研究报告", Nodes: []Node{
				{ID: "brief", Name: "明确研究范围", DurationMS: 10_000, CostMicros: 50_000},
				{ID: "papers", Name: "论文检索", DependsOn: []string{"brief"}, DurationMS: 45_000, MaxAttempts: 3, TimeoutMS: 60_000, BackoffMS: 2_000, Resources: map[string]int{"model": 1}, CostMicros: 200_000},
				{ID: "sources", Name: "官方来源检索", DependsOn: []string{"brief"}, DurationMS: 30_000, MaxAttempts: 2, BackoffMS: 1_000, Resources: map[string]int{"model": 1}, CostMicros: 150_000},
				{ID: "verify", Name: "交叉核验", DependsOn: []string{"papers", "sources"}, DurationMS: 20_000, Resources: map[string]int{"model": 1}, CostMicros: 100_000},
				{ID: "report", Name: "综合报告", DependsOn: []string{"verify"}, DurationMS: 35_000, Resources: map[string]int{"model": 1}, CostMicros: 250_000},
			}}, Options: Options{MaxParallel: 2, Resources: map[string]int{"model": 2}, BudgetMicros: 1_000_000, DeadlineMS: 150_000},
		}},
		{ID: "review", Description: "多分支代码审查与共享测试机器", Request: Request{
			Definition: Definition{Version: 1, Name: "代码审查", Nodes: []Node{
				{ID: "checkout", Name: "准备源码", Kind: "tool", DurationMS: 5_000, Resources: map[string]int{"runner": 1}},
				{ID: "correctness", Name: "正确性审查", DependsOn: []string{"checkout"}, DurationMS: 50_000, Resources: map[string]int{"model": 1}, CostMicros: 400_000},
				{ID: "security", Name: "权限边界审查", DependsOn: []string{"checkout"}, DurationMS: 70_000, Resources: map[string]int{"model": 1}, CostMicros: 600_000},
				{ID: "unit", Name: "单元测试", Kind: "tool", DependsOn: []string{"checkout"}, DurationMS: 30_000, Resources: map[string]int{"runner": 1}, ConcurrencyKey: "tests"},
				{ID: "integration", Name: "集成测试", Kind: "tool", DependsOn: []string{"checkout"}, DurationMS: 60_000, Resources: map[string]int{"runner": 2}, ConcurrencyKey: "tests"},
				{ID: "summary", Name: "汇总审查", DependsOn: []string{"correctness", "security", "unit", "integration"}, DurationMS: 20_000, CostMicros: 200_000},
			}}, Options: Options{MaxParallel: 4, Resources: map[string]int{"model": 2, "runner": 2}, ConcurrencyLimits: map[string]int{"tests": 1}, BudgetMicros: 1_500_000},
		}},
		{ID: "release", Description: "构建、测试和发布审批的时间估算", Request: Request{
			Definition: Definition{Version: 1, Name: "发布预检", Nodes: []Node{
				{ID: "build", Name: "构建", Kind: "tool", DurationMS: 60_000, Resources: map[string]int{"runner": 2}, MaxAttempts: 2, TimeoutMS: 90_000, BackoffMS: 5_000},
				{ID: "test", Name: "回归测试", Kind: "tool", DependsOn: []string{"build"}, DurationMS: 90_000, Resources: map[string]int{"runner": 1}},
				{ID: "docs", Name: "更新文档", DependsOn: []string{"build"}, DurationMS: 30_000, CostMicros: 300_000},
				{ID: "approval", Name: "人工审批估时", Kind: "checkpoint", DependsOn: []string{"test", "docs"}, DurationMS: 120_000},
				{ID: "deploy", Name: "部署估时", Kind: "tool", DependsOn: []string{"approval"}, DurationMS: 30_000, Resources: map[string]int{"runner": 1}},
			}}, Options: Options{MaxParallel: 3, Resources: map[string]int{"runner": 2}, DeadlineMS: 400_000},
		}},
	}
}
