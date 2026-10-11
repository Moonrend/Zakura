// SPDX-License-Identifier: AGPL-3.0-or-later
package campaign

import (
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

const MaxVariants = 16
const MaxDefinitionBytes = 16 << 20

type VariantSpec struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	AgentMapping map[string]string `json:"agentMapping"`
	Models       map[string]string `json:"models,omitempty"`
}

type Variant struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Project         mission.Project `json:"project"`
	DefinitionHash  string          `json:"definitionHash"`
	State           string          `json:"state"`
	CopyOperationID string          `json:"copyOperationId,omitempty"`
	RunID           string          `json:"runId,omitempty"`
	Error           string          `json:"error,omitempty"`
}

type Definition struct {
	Name            string         `json:"name"`
	SourceProjectID string         `json:"sourceProjectId"`
	TemplateID      string         `json:"templateId"`
	TemplateVersion int            `json:"templateVersion"`
	BaselineID      string         `json:"baselineId"`
	Budget          mission.Budget `json:"budget"`
	ReservedBudget  mission.Budget `json:"reservedBudget"`
	Variants        []Variant      `json:"variants"`
}

type Campaign struct {
	ID                 string     `json:"id"`
	TenantID           string     `json:"tenantId"`
	SpaceID            string     `json:"spaceId"`
	Revision           int64      `json:"revision"`
	Status             string     `json:"status"`
	Definition         Definition `json:"definition"`
	BaseSnapshot       string     `json:"baseSnapshot,omitempty"`
	CaptureState       string     `json:"captureState"`
	CaptureOperationID string     `json:"captureOperationId,omitempty"`
	CaptureError       string     `json:"captureError,omitempty"`
	ControlAction      string     `json:"controlAction,omitempty"`
	CreatedBy          string     `json:"createdBy"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

type FrozenRequest struct {
	Name            string
	SourceProjectID string
	TemplateID      string
	TemplateVersion int
	BaselineID      string
	Budget          mission.Budget
	Blueprint       blueprint.Definition
	Inputs          blueprint.Inputs
	Variants        []VariantSpec
}

type Observation struct {
	VariantID     string
	Run           *mission.Run
	Project       *mission.Project
	Tasks         []mission.Task
	Verifications []mission.Verification
	Error         string
}

type Difference struct {
	VariantID string `json:"variantId"`
	TaskID    string `json:"taskId"`
	Field     string `json:"field"`
	Baseline  string `json:"baseline"`
	Candidate string `json:"candidate"`
}

type Measurement struct {
	VariantID              string   `json:"variantId"`
	Name                   string   `json:"name"`
	ProjectID              string   `json:"projectId"`
	RunID                  string   `json:"runId,omitempty"`
	Status                 string   `json:"status"`
	Terminal               bool     `json:"terminal"`
	ChargedTokens          int64    `json:"chargedTokens"`
	ProviderReportedTokens *int64   `json:"providerReportedTokens"`
	ModelCalls             int      `json:"modelCalls"`
	ToolCalls              int      `json:"toolCalls"`
	ElapsedSeconds         float64  `json:"elapsedSeconds"`
	CompletedTasks         int      `json:"completedTasks"`
	TotalTasks             int      `json:"totalTasks"`
	RequiredChecksPassed   int      `json:"requiredChecksPassed"`
	RequiredChecksTotal    int      `json:"requiredChecksTotal"`
	RequiredChecksObserved int      `json:"requiredChecksObserved"`
	AcceptanceRate         *float64 `json:"acceptanceRate"`
	Samples                int      `json:"samples"`
	Unknown                []string `json:"unknown"`
	Error                  string   `json:"error,omitempty"`
}

type Comparison struct {
	BaselineID     string         `json:"baselineId"`
	Comparable     bool           `json:"comparable"`
	Reasons        []string       `json:"reasons"`
	Differences    []Difference   `json:"differences"`
	Measurements   []Measurement  `json:"measurements"`
	ReservedBudget mission.Budget `json:"reservedBudget"`
	ChargedTokens  int64          `json:"chargedTokens"`
	ModelCalls     int            `json:"modelCalls"`
	ToolCalls      int            `json:"toolCalls"`
	ObservedAt     time.Time      `json:"observedAt"`
}
