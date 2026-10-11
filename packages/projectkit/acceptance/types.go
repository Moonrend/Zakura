// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"time"
)

var ErrNotFound = errors.New("acceptance: path not found")

type FileInfo struct {
	Size        int64  `json:"size"`
	IsDir       bool   `json:"isDir"`
	Mode        string `json:"mode,omitempty"`
	ContentHash string `json:"contentHash,omitempty"`
}

// FileSystem is bound to an immutable snapshot. Paths are canonical and relative.
// Implementations must reject symlink escapes and return ErrNotFound for absence.
type FileSystem interface {
	Stat(context.Context, string) (FileInfo, error)
	ReadFile(context.Context, string, int64) ([]byte, error)
}
type CommandRequest struct {
	SnapshotID     string        `json:"snapshotId"`
	CheckID        string        `json:"checkId"`
	Argv           []string      `json:"argv"`
	Directory      string        `json:"directory"`
	Timeout        time.Duration `json:"-"`
	MaxOutputBytes int64         `json:"maxOutputBytes"`
	NoNetwork      bool          `json:"noNetwork"`
}
type CommandResult struct {
	ExitCode        int    `json:"exitCode"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	Truncated       bool   `json:"truncated"`
	NetworkDisabled bool   `json:"networkDisabled"`
	SnapshotID      string `json:"snapshotId"`
	TimedOut        bool   `json:"timedOut,omitempty"`
	Cancelled       bool   `json:"cancelled,omitempty"`
}

// CommandExecutor runs solely on the runner, on the frozen snapshot, without network.
type CommandExecutor interface {
	Execute(context.Context, CommandRequest) (CommandResult, error)
}
type Environment struct {
	SnapshotID string
	Files      FileSystem
	Commands   CommandExecutor
}
type Options struct {
	MaxFileBytes   int64         `json:"maxFileBytes"`
	MaxOutputBytes int64         `json:"maxOutputBytes"`
	DefaultTimeout time.Duration `json:"-"`
	MaxTimeout     time.Duration `json:"-"`
	MaxChecks      int           `json:"maxChecks"`
}
type Evidence struct {
	Version         int    `json:"version"`
	SnapshotID      string `json:"snapshotId"`
	CheckID         string `json:"checkId"`
	SpecHash        string `json:"specHash"`
	Status          string `json:"status"`
	Path            string `json:"path,omitempty"`
	Exists          *bool  `json:"exists,omitempty"`
	IsDir           bool   `json:"isDir,omitempty"`
	Size            int64  `json:"size,omitempty"`
	ContentHash     string `json:"contentHash,omitempty"`
	OutputHash      string `json:"outputHash,omitempty"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	NetworkDisabled bool   `json:"networkDisabled,omitempty"`
	Truncated       bool   `json:"truncated,omitempty"`
	Detail          string `json:"detail,omitempty"`
	ResultHash      string `json:"resultHash"`
	TimedOut        bool   `json:"timedOut,omitempty"`
	Cancelled       bool   `json:"cancelled,omitempty"`
	ProofHash       string `json:"proofHash"`
}
type Report struct {
	SnapshotID string                `json:"snapshotId"`
	Status     string                `json:"status"`
	Checks     []mission.CheckResult `json:"checks"`
	Required   int                   `json:"required"`
	Passed     int                   `json:"passed"`
	Failed     int                   `json:"failed"`
	Errors     int                   `json:"errors"`
	DurationMS int64                 `json:"durationMs"`
}

func (r Report) Verification(id, taskID, branchID string, now time.Time) mission.Verification {
	return mission.Verification{ID: id, TaskID: taskID, BranchID: branchID, SnapshotID: r.SnapshotID, Status: r.Status, Checks: append([]mission.CheckResult(nil), r.Checks...), CreatedAt: now}
}

type Issue struct {
	CheckID string `json:"checkId,omitempty"`
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ValidationError struct {
	Issues []Issue `json:"issues"`
}

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "invalid acceptance checks"
	}
	return "invalid acceptance checks: " + e.Issues[0].Message
}
func DecodeEvidence(raw json.RawMessage) (Evidence, error) {
	var e Evidence
	err := json.Unmarshal(raw, &e)
	return e, err
}
