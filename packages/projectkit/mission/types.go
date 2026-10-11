// SPDX-License-Identifier: AGPL-3.0-or-later
package mission

import (
	"context"
	"encoding/json"
	"time"
)

type Scope struct {
	TenantID  string `json:"tenantId"`
	SpaceID   string `json:"spaceId"`
	ProjectID string `json:"projectId"`
}

type Budget struct {
	MaxTokens      int64 `json:"maxTokens"`
	MaxModelCalls  int   `json:"maxModelCalls"`
	MaxToolCalls   int   `json:"maxToolCalls"`
	MaxWallSeconds int   `json:"maxWallSeconds"`
	MaxConcurrent  int   `json:"maxConcurrent"`
}

type Config struct {
	Budget          Budget `json:"budget"`
	RequireReview   bool   `json:"requireReview"`
	ExternalEffects string `json:"externalEffects"`
	MaxTasks        int    `json:"maxTasks"`
}

type CheckSpec struct {
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	Title            string   `json:"title"`
	Path             string   `json:"path,omitempty"`
	Pattern          string   `json:"pattern,omitempty"`
	Command          []string `json:"command,omitempty"`
	TimeoutSeconds   int      `json:"timeoutSeconds,omitempty"`
	ExpectedExitCode int      `json:"expectedExitCode,omitempty"`
	Required         bool     `json:"required"`
}

type TaskSpec struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Prompt      string      `json:"prompt"`
	AgentID     string      `json:"agentId"`
	Model       string      `json:"model,omitempty"`
	DependsOn   []string    `json:"dependsOn"`
	Writes      []string    `json:"writes"`
	Priority    int         `json:"priority"`
	MaxAttempts int         `json:"maxAttempts"`
	Checks      []CheckSpec `json:"checks"`
}

type Plan struct {
	Version int        `json:"version"`
	Tasks   []TaskSpec `json:"tasks"`
}

type Project struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenantId"`
	SpaceID   string    `json:"spaceId"`
	Name      string    `json:"name"`
	Goal      string    `json:"goal"`
	Status    string    `json:"status"`
	Revision  int64     `json:"revision"`
	Plan      Plan      `json:"plan"`
	Config    Config    `json:"config"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Run struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"projectId"`
	Status       string    `json:"status"`
	Revision     int64     `json:"revision"`
	PlanVersion  int       `json:"planVersion"`
	BaseSnapshot string    `json:"baseSnapshot"`
	Owner        string    `json:"owner,omitempty"`
	Tokens       int64     `json:"tokens"`
	ModelCalls   int       `json:"modelCalls"`
	ToolCalls    int       `json:"toolCalls"`
	Error        string    `json:"error,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Task struct {
	ID               string     `json:"id"`
	RunID            string     `json:"runId"`
	Spec             TaskSpec   `json:"spec"`
	Status           string     `json:"status"`
	Attempt          int        `json:"attempt"`
	Revision         int64      `json:"revision"`
	SessionID        string     `json:"sessionId"`
	ReusedFromRunID  string     `json:"reusedFromRunId,omitempty"`
	ReusedFromTaskID string     `json:"reusedFromTaskId,omitempty"`
	BranchID         string     `json:"branchId"`
	BaseSnapshot     string     `json:"baseSnapshot"`
	ForkSnapshotID   string     `json:"forkSnapshotId,omitempty"`
	SnapshotID       string     `json:"snapshotId"`
	CheckpointID     string     `json:"checkpointId"`
	LeaseOwner       string     `json:"leaseOwner,omitempty"`
	LeaseUntil       *time.Time `json:"leaseUntil,omitempty"`
	Fence            int64      `json:"fence"`
	Result           string     `json:"result,omitempty"`
	Error            string     `json:"error,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}

type Message = map[string]any

type Checkpoint struct {
	ID        string          `json:"id"`
	TaskID    string          `json:"taskId"`
	Sequence  int64           `json:"sequence"`
	Messages  []Message       `json:"messages"`
	Decision  *Decision       `json:"decision,omitempty"`
	NextTool  int             `json:"nextTool"`
	Context   json.RawMessage `json:"context,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Effect    string          `json:"effect"`
}

type Decision struct {
	Message Message    `json:"message"`
	Tools   []ToolCall `json:"tools"`
	Done    bool       `json:"done"`
	Result  string     `json:"result"`
	Tokens  int64      `json:"tokens"`
}

type Operation struct {
	ID            string          `json:"id"`
	Scope         Scope           `json:"scope"`
	RunID         string          `json:"runId"`
	TaskID        string          `json:"taskId"`
	CheckpointID  string          `json:"checkpointId"`
	Call          ToolCall        `json:"call"`
	Status        string          `json:"status"`
	ArgumentsHash string          `json:"argumentsHash"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         string          `json:"error,omitempty"`
	Revision      int64           `json:"revision"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

type ToolResult struct {
	Content json.RawMessage `json:"content"`
	Error   string          `json:"error,omitempty"`
}

type Inspection struct {
	Known  bool       `json:"known"`
	Result ToolResult `json:"result"`
}

type Assignment struct {
	TokenAllowance    int64             `json:"tokenAllowance"`
	Scope             Scope             `json:"scope"`
	Run               Run               `json:"run"`
	Task              Task              `json:"task"`
	Project           Project           `json:"project"`
	Checkpoint        Checkpoint        `json:"checkpoint"`
	DependencyResults map[string]string `json:"dependencyResults"`
}

// Executor makes one model decision at a time. The engine persists a decision
// before invoking any tools. Unknown external effects are never blindly replayed.
type Executor interface {
	Advance(context.Context, Assignment) (Decision, error)
	Perform(context.Context, Assignment, Operation) (ToolResult, error)
	Inspect(context.Context, Assignment, Operation) (Inspection, error)
}

type CheckResult struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Status     string          `json:"status"`
	Summary    string          `json:"summary"`
	Output     string          `json:"output,omitempty"`
	DurationMS int64           `json:"durationMs"`
	Required   bool            `json:"required"`
	Evidence   json.RawMessage `json:"evidence,omitempty"`
}

type Verification struct {
	ID         string        `json:"id"`
	TaskID     string        `json:"taskId"`
	BranchID   string        `json:"branchId"`
	SnapshotID string        `json:"snapshotId"`
	Status     string        `json:"status"`
	Checks     []CheckResult `json:"checks"`
	CreatedAt  time.Time     `json:"createdAt"`
}

// WorkspaceProvider returns runner-owned opaque branch and snapshot IDs. It
// never accepts filesystem roots or mount flags from an untrusted API caller.
type WorkspaceProvider interface {
	Base(context.Context, Scope) (string, error)
	Compose(context.Context, Scope, string, []string) (string, error)
	Fork(context.Context, Scope, string, string) (string, error)
	Snapshot(context.Context, Scope, string) (string, error)
	ValidateWrites(context.Context, Scope, string, string, []string) error
	Verify(context.Context, Scope, string, []CheckSpec) (Verification, error)
}

type Event struct {
	ID        string          `json:"id"`
	ProjectID string          `json:"projectId"`
	RunID     string          `json:"runId,omitempty"`
	TaskID    string          `json:"taskId,omitempty"`
	Sequence  int64           `json:"sequence"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

type Review struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	RunID      string    `json:"runId"`
	TaskID     string    `json:"taskId"`
	SnapshotID string    `json:"snapshotId"`
	Decision   string    `json:"decision"`
	AuthorID   string    `json:"authorId"`
	Comment    string    `json:"comment"`
	CreatedAt  time.Time `json:"createdAt"`
}
