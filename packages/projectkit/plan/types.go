// SPDX-License-Identifier: AGPL-3.0-or-later
package plan

import (
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"time"
)

type Issue struct {
	Code    string   `json:"code"`
	TaskID  string   `json:"taskId,omitempty"`
	CheckID string   `json:"checkId,omitempty"`
	Field   string   `json:"field"`
	Message string   `json:"message"`
	Related []string `json:"related,omitempty"`
}
type ValidationError struct {
	Issues []Issue `json:"issues"`
}

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "invalid project plan"
	}
	return fmt.Sprintf("invalid project plan (%d issues): %s", len(e.Issues), e.Issues[0].Message)
}

type Node struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	AgentID        string  `json:"agentId,omitempty"`
	Layer          int     `json:"layer"`
	Order          int     `json:"order"`
	EarliestStart  int     `json:"earliestStart"`
	EarliestFinish int     `json:"earliestFinish"`
	LatestStart    int     `json:"latestStart"`
	LatestFinish   int     `json:"latestFinish"`
	Slack          int     `json:"slack"`
	Critical       bool    `json:"critical"`
	Ancestors      int     `json:"ancestors"`
	Descendants    int     `json:"descendants"`
	X              float64 `json:"x"`
	Y              float64 `json:"y"`
}
type Edge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Critical bool   `json:"critical"`
}
type WriteConflict struct {
	LeftTask  string `json:"leftTask"`
	RightTask string `json:"rightTask"`
	LeftPath  string `json:"leftPath"`
	RightPath string `json:"rightPath"`
	Ordered   bool   `json:"ordered"`
	Witness   string `json:"witness"`
}
type Analysis struct {
	PlanVersion                int             `json:"planVersion"`
	Topological                []string        `json:"topological"`
	Roots                      []string        `json:"roots"`
	Leaves                     []string        `json:"leaves"`
	Nodes                      []Node          `json:"nodes"`
	Edges                      []Edge          `json:"edges"`
	CriticalPath               []string        `json:"criticalPath"`
	CriticalLength             int             `json:"criticalLength"`
	Layers                     [][]string      `json:"layers"`
	MaxLayerWidth              int             `json:"maxLayerWidth"`
	Conflicts                  []WriteConflict `json:"conflicts"`
	RequiredChecks             int             `json:"requiredChecks"`
	TasksWithoutRequiredChecks []string        `json:"tasksWithoutRequiredChecks"`
	Warnings                   []Issue         `json:"warnings"`
}
type Estimate struct {
	Tokens     int64          `json:"tokens"`
	ModelCalls int            `json:"modelCalls"`
	ToolCalls  int            `json:"toolCalls"`
	Seconds    int            `json:"seconds"`
	Resources  map[string]int `json:"resources,omitempty"`
}
type Usage struct {
	Tokens      int64 `json:"tokens"`
	ModelCalls  int   `json:"modelCalls"`
	ToolCalls   int   `json:"toolCalls"`
	WallSeconds int   `json:"wallSeconds"`
}
type ScheduleOptions struct {
	Now                   time.Time
	WaitingSince          map[string]time.Time
	Estimates             map[string]Estimate
	Used                  Usage
	ResourceLimits        map[string]int
	ActiveResources       map[string]int
	AgingSeconds          int
	PriorityWeight        float64
	CriticalWeight        float64
	AgingWeight           float64
	FairnessWeight        float64
	RequireKnownEstimates bool
}
type Candidate struct {
	TaskID          string    `json:"taskId"`
	AgentID         string    `json:"agentId"`
	Score           float64   `json:"score"`
	PriorityScore   float64   `json:"priorityScore"`
	CriticalScore   float64   `json:"criticalScore"`
	AgingScore      float64   `json:"agingScore"`
	FairnessPenalty float64   `json:"fairnessPenalty"`
	Estimate        *Estimate `json:"estimate,omitempty"`
	Reasons         []string  `json:"reasons"`
}
type Deferred struct {
	TaskID  string   `json:"taskId"`
	Codes   []string `json:"codes"`
	Detail  string   `json:"detail"`
	Related []string `json:"related,omitempty"`
}
type ScheduleResult struct {
	Selected       []Candidate `json:"selected"`
	Ranked         []Candidate `json:"ranked"`
	Deferred       []Deferred  `json:"deferred"`
	Active         []string    `json:"active"`
	Reserved       Usage       `json:"reserved"`
	AvailableSlots int         `json:"availableSlots"`
	Warnings       []Issue     `json:"warnings"`
}
type TaskChange struct {
	TaskID            string   `json:"taskId"`
	Kind              string   `json:"kind"`
	Fields            []string `json:"fields,omitempty"`
	ExecutionChanged  bool     `json:"executionChanged"`
	AcceptanceChanged bool     `json:"acceptanceChanged"`
}
type ReplanResult struct {
	Changes        []TaskChange        `json:"changes"`
	Added          []string            `json:"added"`
	Removed        []string            `json:"removed"`
	Invalidated    []string            `json:"invalidated"`
	Retained       []string            `json:"retained"`
	Interrupted    []string            `json:"interrupted"`
	ReplayRequired []string            `json:"replayRequired"`
	Reasons        map[string][]string `json:"reasons"`
	SafeToApply    bool                `json:"safeToApply"`
	Analysis       Analysis            `json:"analysis"`
}
type CompareOptions struct {
	BaseEstimates      map[string]Estimate
	CandidateEstimates map[string]Estimate
	CostWeight         float64
	VerificationWeight float64
	ArtifactWeight     float64
	RiskWeight         float64
}
type Metric struct {
	Name        string  `json:"name"`
	Base        float64 `json:"base"`
	Candidate   float64 `json:"candidate"`
	Delta       float64 `json:"delta"`
	Weight      float64 `json:"weight"`
	Explanation string  `json:"explanation"`
}
type AlternativeScore struct {
	Cost             float64 `json:"cost"`
	Verification     float64 `json:"verification"`
	Artifacts        float64 `json:"artifacts"`
	Risk             float64 `json:"risk"`
	Total            float64 `json:"total"`
	EstimateCoverage float64 `json:"estimateCoverage"`
	KnownCost        Usage   `json:"knownCost"`
	CriticalSeconds  int     `json:"criticalSeconds"`
}
type Comparison struct {
	Base           AlternativeScore `json:"base"`
	Candidate      AlternativeScore `json:"candidate"`
	Metrics        []Metric         `json:"metrics"`
	Changes        []TaskChange     `json:"changes"`
	Recommendation string           `json:"recommendation"`
	Comparable     bool             `json:"comparable"`
	Uncertainty    []string         `json:"uncertainty"`
}

// Graph is immutable once compiled. Accessors return copies.
type Graph struct {
	plan         mission.Plan
	order        []string
	byID         map[string]mission.TaskSpec
	dependencies map[string][]string
	dependents   map[string][]string
	ancestors    map[string][]uint64
	descendants  map[string][]uint64
	index        map[string]int
}
