// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

var (
	ErrNotFound       = errors.New("project execution resource not found")
	ErrConflict       = errors.New("project execution revision conflict")
	ErrLeaseLost      = errors.New("project execution worker lease lost")
	ErrBudgetExceeded = errors.New("project execution budget exhausted")
	ErrInvalidState   = errors.New("invalid project execution state transition")
	ErrClosed         = errors.New("project execution engine is closed")
	ErrTenantDraining = errors.New("tenant project execution is draining")
)

// FenceRequest identifies an execution incarnation. Every worker write verifies
// both the owner and monotonically increasing fence in the database transaction.
type FenceRequest struct {
	Scope  mission.Scope
	RunID  string
	TaskID string
	Owner  string
	Fence  int64
}

type LeaseRef = FenceRequest

type BudgetReservation struct {
	ModelCalls int
	ToolCalls  int
	Tokens     int64
}

// Resolution is an explicit human attestation concerning an ambiguous effect.
// not_performed authorizes another attempt only after the operator has verified
// that the original operation did not take effect in the external system.
type Resolution struct {
	Decision string          `json:"decision"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
	AuthorID string          `json:"authorId"`
	Comment  string          `json:"comment"`
}

type EngineConfig struct {
	WorkerID          string
	Workers           int
	Lease             time.Duration
	HeartbeatInterval time.Duration
	PollInterval      time.Duration
	MaxTurns          int
	MaxDecisionTokens int64
	OnError           func(error)
}

func DefaultEngineConfig() EngineConfig {
	return EngineConfig{Workers: 4, Lease: 30 * time.Second, HeartbeatInterval: 10 * time.Second, PollInterval: 500 * time.Millisecond, MaxTurns: 128, MaxDecisionTokens: 8192}
}

type ExecutionError struct {
	Scope  mission.Scope
	RunID  string
	TaskID string
	Stage  string
	Cause  error
}

func (e *ExecutionError) Error() string {
	return fmt.Sprintf("project %s run %s task %s %s: %v", e.Scope.ProjectID, e.RunID, e.TaskID, e.Stage, e.Cause)
}
func (e *ExecutionError) Unwrap() error { return e.Cause }
