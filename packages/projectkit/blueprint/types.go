// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"encoding/json"
	"fmt"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

const Schema = "zakura.project-blueprint"
const Version = 1
const MaxDocumentBytes = 2 << 20
const MaxExpandedTasks = 1000
const MaxExpandedBytes = 16 << 20

// Definition is declarative data. It contains no template functions or scripts.
type Definition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	ProjectName string         `json:"projectName"`
	Goal        string         `json:"goal"`
	Parameters  []Parameter    `json:"parameters"`
	Tasks       []Task         `json:"tasks"`
	Config      mission.Config `json:"config"`
}

type Parameter struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Type        string          `json:"type"`
	Required    bool            `json:"required"`
	Default     json.RawMessage `json:"default,omitempty"`
	Enum        []string        `json:"enum,omitempty"`
	Minimum     *int64          `json:"minimum,omitempty"`
	Maximum     *int64          `json:"maximum,omitempty"`
	MinLength   int             `json:"minLength,omitempty"`
	MaxLength   int             `json:"maxLength,omitempty"`
	Pattern     string          `json:"pattern,omitempty"`
}

// Matrix values are strings and may reference parameters. Axis names and task
// keys are identifiers, never interpolated strings. Dependency selectors refer
// to equal axis values, so a locale-specific test can depend on just its build.
type Task struct {
	Key         string              `json:"key"`
	Title       string              `json:"title"`
	Prompt      string              `json:"prompt"`
	AgentRole   string              `json:"agentRole"`
	Model       string              `json:"model,omitempty"`
	DependsOn   []Dependency        `json:"dependsOn"`
	Writes      []string            `json:"writes"`
	Priority    int                 `json:"priority"`
	MaxAttempts int                 `json:"maxAttempts"`
	Checks      []mission.CheckSpec `json:"checks"`
	Matrix      map[string][]string `json:"matrix,omitempty"`
	When        *Condition          `json:"when,omitempty"`
}

type Dependency struct {
	Task      string   `json:"task"`
	MatchAxes []string `json:"matchAxes,omitempty"`
}

// A condition is exactly one of a predicate, all, any or not. Predicate refs
// use param.NAME or matrix.AXIS, and are evaluated on scalar JSON values.
type Condition struct {
	Ref    string            `json:"ref,omitempty"`
	Op     string            `json:"op,omitempty"`
	Value  json.RawMessage   `json:"value,omitempty"`
	Values []json.RawMessage `json:"values,omitempty"`
	All    []Condition       `json:"all,omitempty"`
	Any    []Condition       `json:"any,omitempty"`
	Not    *Condition        `json:"not,omitempty"`
}

type Document struct {
	Schema    string     `json:"schema"`
	Version   int        `json:"version"`
	Blueprint Definition `json:"blueprint"`
}

type Inputs struct {
	Parameters   map[string]json.RawMessage `json:"parameters"`
	AgentMapping map[string]string          `json:"agentMapping"`
	SpaceID      string                     `json:"spaceId"`
	Name         string                     `json:"name,omitempty"`
}

type Instance struct {
	TaskID string            `json:"taskId"`
	Key    string            `json:"key"`
	Axes   map[string]string `json:"axes"`
}

type Expansion struct {
	Project   mission.Project `json:"project"`
	Analysis  plan.Analysis   `json:"analysis"`
	Instances []Instance      `json:"instances"`
	Skipped   []Instance      `json:"skipped"`
	Roles     []string        `json:"roles"`
}

type Issue struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ValidationError struct {
	Issues []Issue `json:"issues"`
}

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "invalid project blueprint"
	}
	return fmt.Sprintf("invalid project blueprint: %s (%s)", e.Issues[0].Message, e.Issues[0].Field)
}

func invalid(field, code, message string) error {
	return &ValidationError{Issues: []Issue{{Field: field, Code: code, Message: message}}}
}
