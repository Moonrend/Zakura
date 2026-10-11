// SPDX-License-Identifier: AGPL-3.0-or-later
package requirements

import (
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"time"
)

type Binding struct {
	TaskSpecID string `json:"taskSpecId"`
	CheckID    string `json:"checkId"`
}
type Clause struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Required    bool      `json:"required"`
	Bindings    []Binding `json:"bindings"`
}
type Draft struct {
	Title                     string   `json:"title"`
	Clauses                   []Clause `json:"clauses"`
	RequiredBeforePublication bool     `json:"requiredBeforePublication"`
}
type Baseline struct {
	ID                        string       `json:"id"`
	ProjectID                 string       `json:"projectId"`
	Title                     string       `json:"title"`
	Clauses                   []Clause     `json:"clauses"`
	RequiredBeforePublication bool         `json:"requiredBeforePublication"`
	Revision                  int64        `json:"revision"`
	Status                    string       `json:"status"`
	ApprovedBy                string       `json:"approvedBy,omitempty"`
	ApprovedAt                *time.Time   `json:"approvedAt,omitempty"`
	ApprovedPlan              mission.Plan `json:"approvedPlan"`
	ApprovedPlanHash          string       `json:"approvedPlanHash,omitempty"`
	CreatedBy                 string       `json:"createdBy"`
	UpdatedBy                 string       `json:"updatedBy"`
	CreatedAt                 time.Time    `json:"createdAt"`
	UpdatedAt                 time.Time    `json:"updatedAt"`
}
type Revision struct {
	Baseline  Baseline  `json:"baseline"`
	Action    string    `json:"action"`
	AuthorID  string    `json:"authorId"`
	Comment   string    `json:"comment"`
	CreatedAt time.Time `json:"createdAt"`
}
type RunBinding struct {
	RunID            string    `json:"runId"`
	BaselineID       string    `json:"baselineId"`
	BaselineRevision int64     `json:"baselineRevision"`
	BaselineHash     string    `json:"baselineHash"`
	Baseline         Baseline  `json:"baseline"`
	FrozenPlanHash   string    `json:"frozenPlanHash"`
	BoundBy          string    `json:"boundBy"`
	BoundAt          time.Time `json:"boundAt"`
}
type Issue struct {
	Code       string `json:"code"`
	ClauseID   string `json:"clauseId,omitempty"`
	TaskSpecID string `json:"taskSpecId,omitempty"`
	CheckID    string `json:"checkId,omitempty"`
	Severity   string `json:"severity"`
	Message    string `json:"message"`
}
type Analysis struct {
	PlanHash string  `json:"planHash"`
	Valid    bool    `json:"valid"`
	Required int     `json:"required"`
	Optional int     `json:"optional"`
	Issues   []Issue `json:"issues"`
}
type Evidence struct {
	TaskSpecID     string `json:"taskSpecId"`
	TaskID         string `json:"taskId,omitempty"`
	CheckID        string `json:"checkId"`
	Status         string `json:"status"`
	Reason         string `json:"reason"`
	SnapshotID     string `json:"snapshotId,omitempty"`
	VerificationID string `json:"verificationId,omitempty"`
	ReviewID       string `json:"reviewId,omitempty"`
	Summary        string `json:"summary,omitempty"`
}
type CoverageRow struct {
	Clause   Clause     `json:"clause"`
	Status   string     `json:"status"`
	Evidence []Evidence `json:"evidence"`
}
type Coverage struct {
	RunID                     string        `json:"runId"`
	BaselineID                string        `json:"baselineId"`
	BaselineRevision          int64         `json:"baselineRevision"`
	BaselineHash              string        `json:"baselineHash"`
	FrozenPlanHash            string        `json:"frozenPlanHash"`
	ApprovedPlanHash          string        `json:"approvedPlanHash"`
	Bound                     bool          `json:"bound"`
	RequiredBeforePublication bool          `json:"requiredBeforePublication"`
	PublicationAllowed        bool          `json:"publicationAllowed"`
	RequiredPassed            int           `json:"requiredPassed"`
	RequiredTotal             int           `json:"requiredTotal"`
	Rows                      []CoverageRow `json:"rows"`
	Issues                    []Issue       `json:"issues"`
}

// Reviews contains the latest local task review by durable project event
// sequence, rather than wall-clock timestamps that can move backwards.
type Input struct {
	Binding       RunBinding
	FrozenProject mission.Project
	Run           mission.Run
	Tasks         []mission.Task
	Verifications map[string]mission.Verification
	Reviews       map[string]mission.Review
}
