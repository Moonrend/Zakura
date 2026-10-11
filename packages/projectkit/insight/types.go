// SPDX-License-Identifier: AGPL-3.0-or-later
// Package insight interprets persisted execution evidence and simulates explicit
// scheduling assumptions. It never dispatches tools or modifies execution state.
package insight

import (
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

const (
	MaxTasks      = 1000
	MaxEvents     = 50000
	MaxOperations = 50000
	MaxRuns       = 50
	MaxScenarios  = 8
	MaxResources  = 32
)

type Evidence struct {
	Project         mission.Project        `json:"project"`
	Run             mission.Run            `json:"run"`
	Tasks           []mission.Task         `json:"tasks"`
	Events          []mission.Event        `json:"events"`
	Operations      []mission.Operation    `json:"operations"`
	Verifications   []mission.Verification `json:"verifications"`
	Reviews         []mission.Review       `json:"reviews"`
	EventsTruncated bool                   `json:"eventsTruncated"`
}

type Notice struct {
	Code    string `json:"code"`
	TaskID  string `json:"taskId,omitempty"`
	Message string `json:"message"`
}

// Interval is a measured wall-clock execution span, not CPU time. An open span
// deliberately has no duration; crashes and clock reversals cannot invent one.
type Interval struct {
	Start         time.Time  `json:"start"`
	End           *time.Time `json:"end,omitempty"`
	Seconds       *float64   `json:"seconds,omitempty"`
	StartSequence int64      `json:"startSequence"`
	EndSequence   int64      `json:"endSequence,omitempty"`
	Outcome       string     `json:"outcome"`
	Recoveries    int        `json:"recoveries"`
}

type Checkpoint struct {
	ID            string    `json:"id"`
	Sequence      int64     `json:"sequence"`
	NextTool      int       `json:"nextTool"`
	EventSequence int64     `json:"eventSequence"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Blocker struct {
	Code        string   `json:"code"`
	TaskID      string   `json:"taskId,omitempty"`
	OperationID string   `json:"operationId,omitempty"`
	Message     string   `json:"message"`
	Evidence    string   `json:"evidence"`
	Chain       []string `json:"chain,omitempty"`
}

type Usage struct {
	Tokens     int64 `json:"tokens"`
	ModelCalls int   `json:"modelCalls"`
	ToolCalls  int   `json:"toolCalls"`
}

type TaskInsight struct {
	TaskID                  string         `json:"taskId"`
	SpecID                  string         `json:"specId"`
	Title                   string         `json:"title"`
	Status                  string         `json:"status"`
	Attempt                 int            `json:"attempt"`
	Reused                  bool           `json:"reused"`
	Intervals               []Interval     `json:"intervals"`
	ObservedSeconds         *float64       `json:"observedSeconds,omitempty"`
	DurationComplete        bool           `json:"durationComplete"`
	FirstStartedAt          *time.Time     `json:"firstStartedAt,omitempty"`
	FinishedAt              *time.Time     `json:"finishedAt,omitempty"`
	ReviewSeconds           *float64       `json:"reviewSeconds,omitempty"`
	RetryRequests           int            `json:"retryRequests"`
	Recoveries              int            `json:"recoveries"`
	Checkpoints             []Checkpoint   `json:"checkpoints"`
	Usage                   Usage          `json:"usage"`
	OperationStatuses       map[string]int `json:"operationStatuses"`
	VerificationStatuses    map[string]int `json:"verificationStatuses"`
	TokensPerObservedSecond *float64       `json:"tokensPerObservedSecond,omitempty"`
	Blockers                []Blocker      `json:"blockers"`
	Warnings                []Notice       `json:"warnings"`
}

type CriticalPath struct {
	TaskIDs                []string `json:"taskIds"`
	Seconds                *float64 `json:"seconds,omitempty"`
	KnownLowerBoundSeconds float64  `json:"knownLowerBoundSeconds"`
	UnknownTaskIDs         []string `json:"unknownTaskIds"`
}

type RunInsight struct {
	RunID             string         `json:"runId"`
	ProjectID         string         `json:"projectId"`
	PlanVersion       int            `json:"planVersion"`
	Status            string         `json:"status"`
	CreatedAt         time.Time      `json:"createdAt"`
	Usage             Usage          `json:"usage"`
	AttributedUsage   Usage          `json:"attributedUsage"`
	UnattributedUsage Usage          `json:"unattributedUsage"`
	ElapsedSeconds    *float64       `json:"elapsedSeconds,omitempty"`
	FinishedAt        *time.Time     `json:"finishedAt,omitempty"`
	Tasks             []TaskInsight  `json:"tasks"`
	CriticalPath      CriticalPath   `json:"criticalPath"`
	StatusCounts      map[string]int `json:"statusCounts"`
	Warnings          []Notice       `json:"warnings"`
	EventCount        int            `json:"eventCount"`
	EvidenceComplete  bool           `json:"evidenceComplete"`
}

type DurationEstimate struct {
	SpecID         string              `json:"specId"`
	Source         string              `json:"source"`
	Samples        int                 `json:"samples"`
	P50Seconds     *float64            `json:"p50Seconds,omitempty"`
	P90Seconds     *float64            `json:"p90Seconds,omitempty"`
	MedianInterval *ConfidenceInterval `json:"medianInterval,omitempty"`
	RunIDs         []string            `json:"runIds"`
	Warnings       []string            `json:"warnings"`
}

type ConfidenceInterval struct {
	Low        float64 `json:"low"`
	High       float64 `json:"high"`
	Confidence float64 `json:"confidence"`
	Replicates int     `json:"replicates"`
}

type ProjectInsight struct {
	ProjectID string             `json:"projectId"`
	Runs      []RunInsight       `json:"runs"`
	Estimates []DurationEstimate `json:"estimates"`
	Warnings  []Notice           `json:"warnings"`
}

type TaskComparison struct {
	SpecID               string       `json:"specId"`
	Change               string       `json:"change"`
	Comparable           bool         `json:"comparable"`
	Reason               string       `json:"reason,omitempty"`
	Left                 *TaskInsight `json:"left,omitempty"`
	Right                *TaskInsight `json:"right,omitempty"`
	DurationDeltaSeconds *float64     `json:"durationDeltaSeconds,omitempty"`
	TokenDelta           *int64       `json:"tokenDelta,omitempty"`
}

type Comparison struct {
	Left     RunInsight       `json:"left"`
	Right    RunInsight       `json:"right"`
	Tasks    []TaskComparison `json:"tasks"`
	Warnings []Notice         `json:"warnings"`
}

type CostEstimate struct {
	Tokens     int64 `json:"tokens"`
	ModelCalls int   `json:"modelCalls"`
	ToolCalls  int   `json:"toolCalls"`
}

type Scenario struct {
	ID              string                    `json:"id"`
	Label           string                    `json:"label"`
	MaxConcurrent   int                       `json:"maxConcurrent"`
	Durations       map[string]float64        `json:"durations"`
	Capacities      map[string]int            `json:"capacities"`
	Resources       map[string]map[string]int `json:"resources"`
	Costs           map[string]CostEstimate   `json:"costs"`
	SerializeWrites *bool                     `json:"serializeWrites,omitempty"`
}

type SimulationRequest struct {
	Scenarios []Scenario `json:"scenarios"`
	Quantile  float64    `json:"quantile,omitempty"`
}

type TimelineEntry struct {
	SpecID          string         `json:"specId"`
	StartSeconds    float64        `json:"startSeconds"`
	EndSeconds      float64        `json:"endSeconds"`
	DurationSeconds float64        `json:"durationSeconds"`
	DurationSource  string         `json:"durationSource"`
	Resources       map[string]int `json:"resources"`
}

type BudgetAssessment struct {
	Status         string       `json:"status"`
	Known          CostEstimate `json:"known"`
	MissingTaskIDs []string     `json:"missingTaskIds"`
	Exceeded       []string     `json:"exceeded"`
	Message        string       `json:"message"`
}

type ScenarioResult struct {
	ID                  string             `json:"id"`
	Label               string             `json:"label"`
	Status              string             `json:"status"`
	MaxConcurrent       int                `json:"maxConcurrent"`
	MakespanSeconds     *float64           `json:"makespanSeconds,omitempty"`
	Utilization         *float64           `json:"utilization,omitempty"`
	ResourceUtilization map[string]float64 `json:"resourceUtilization"`
	Timeline            []TimelineEntry    `json:"timeline"`
	CriticalPath        CriticalPath       `json:"criticalPath"`
	UnknownTaskIDs      []string           `json:"unknownTaskIds"`
	Blockers            []Blocker          `json:"blockers"`
	Budget              BudgetAssessment   `json:"budget"`
	Warnings            []string           `json:"warnings"`
}

type Simulation struct {
	RunID       string             `json:"runId"`
	PlanVersion int                `json:"planVersion"`
	Quantile    float64            `json:"quantile"`
	Estimates   []DurationEstimate `json:"estimates"`
	Scenarios   []ScenarioResult   `json:"scenarios"`
	Assumptions []string           `json:"assumptions"`
}
