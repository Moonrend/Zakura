// SPDX-License-Identifier: AGPL-3.0-or-later
// Package workflow provides bounded, deterministic, side-effect-free preflight
// analysis. It does not dispatch agents, execute tools, or contact providers.
package workflow

const (
	Version             = 1
	MaxNodes            = 128
	MaxEdges            = 2048
	MaxResources        = 32
	MaxDurationMS int64 = 86_400_000
	MaxCostMicros int64 = 1_000_000_000_000
	MaxLimit      int64 = 1_000_000_000_000_000
)

type Node struct {
	ID                string         `json:"id"`
	Name              string         `json:"name,omitempty"`
	Kind              string         `json:"kind,omitempty"`
	DependsOn         []string       `json:"dependsOn,omitempty"`
	DurationMS        int64          `json:"durationMs"`
	TimeoutMS         int64          `json:"timeoutMs,omitempty"`
	MaxAttempts       int            `json:"maxAttempts,omitempty"`
	BackoffMS         int64          `json:"backoffMs,omitempty"`
	BackoffMultiplier int            `json:"backoffMultiplier,omitempty"`
	MaxBackoffMS      int64          `json:"maxBackoffMs,omitempty"`
	CostMicros        int64          `json:"costMicros,omitempty"`
	Resources         map[string]int `json:"resources,omitempty"`
	ConcurrencyKey    string         `json:"concurrencyKey,omitempty"`
}

type Definition struct {
	Version int    `json:"version"`
	Name    string `json:"name"`
	Nodes   []Node `json:"nodes"`
}

type Options struct {
	MaxParallel       int            `json:"maxParallel,omitempty"`
	Resources         map[string]int `json:"resources,omitempty"`
	ConcurrencyLimits map[string]int `json:"concurrencyLimits,omitempty"`
	Mode              string         `json:"mode,omitempty"`
	Priority          string         `json:"priority,omitempty"`
	BudgetMicros      int64          `json:"budgetMicros,omitempty"`
	DeadlineMS        int64          `json:"deadlineMs,omitempty"`
}

type Request struct {
	Definition Definition `json:"definition"`
	Options    Options    `json:"options"`
}

type Diagnostic struct {
	Severity string   `json:"severity"`
	Code     string   `json:"code"`
	Path     string   `json:"path"`
	Message  string   `json:"message"`
	NodeIDs  []string `json:"nodeIds,omitempty"`
}

type Validation struct {
	Valid            bool         `json:"valid"`
	Diagnostics      []Diagnostic `json:"diagnostics"`
	TopologicalOrder []string     `json:"topologicalOrder"`
	Layers           [][]string   `json:"layers"`
}

type NodeAnalysis struct {
	ID               string `json:"id"`
	DurationMS       int64  `json:"durationMs"`
	RetryBoundMS     int64  `json:"retryBoundMs"`
	CostMicros       int64  `json:"costMicros"`
	EarliestStartMS  int64  `json:"earliestStartMs"`
	EarliestFinishMS int64  `json:"earliestFinishMs"`
	LatestStartMS    int64  `json:"latestStartMs"`
	SlackMS          int64  `json:"slackMs"`
	TailMS           int64  `json:"tailMs"`
	Level            int    `json:"level"`
	Critical         bool   `json:"critical"`
}

type Analysis struct {
	Nodes                 []NodeAnalysis   `json:"nodes"`
	Roots                 []string         `json:"roots"`
	Sinks                 []string         `json:"sinks"`
	CriticalPath          []string         `json:"criticalPath"`
	CriticalPathMS        int64            `json:"criticalPathMs"`
	TotalWorkMS           int64            `json:"totalWorkMs"`
	TotalCostMicros       int64            `json:"totalCostMicros"`
	ParallelLowerBoundMS  int64            `json:"parallelLowerBoundMs"`
	ResourceLowerBoundsMS map[string]int64 `json:"resourceLowerBoundsMs"`
}

type Slot struct {
	NodeID         string         `json:"nodeId"`
	StartMS        int64          `json:"startMs"`
	EndMS          int64          `json:"endMs"`
	WaitMS         int64          `json:"waitMs"`
	Resources      map[string]int `json:"resources"`
	ConcurrencyKey string         `json:"concurrencyKey,omitempty"`
}

type Usage struct {
	AtMS      int64          `json:"atMs"`
	Running   int            `json:"running"`
	Resources map[string]int `json:"resources"`
}

type Schedule struct {
	Slots          []Slot         `json:"slots"`
	Usage          []Usage        `json:"usage"`
	MakespanMS     int64          `json:"makespanMs"`
	PeakParallel   int            `json:"peakParallel"`
	PeakResources  map[string]int `json:"peakResources"`
	Utilization    float64        `json:"utilization"`
	WithinBudget   bool           `json:"withinBudget"`
	WithinDeadline bool           `json:"withinDeadline"`
	Optimal        bool           `json:"optimal"`
}

type Result struct {
	Version     int        `json:"version"`
	Fingerprint string     `json:"fingerprint"`
	Options     Options    `json:"options"`
	Validation  Validation `json:"validation"`
	Analysis    *Analysis  `json:"analysis,omitempty"`
	Schedule    *Schedule  `json:"schedule,omitempty"`
}
