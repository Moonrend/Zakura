// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"time"
)

var ErrResourceBusy = errors.New("project dispatch resource is busy")

type ResourceBusyError struct {
	Code    string
	RetryAt time.Time
}

func (e *ResourceBusyError) Error() string { return fmt.Sprintf("%s: %s", ErrResourceBusy, e.Code) }
func (e *ResourceBusyError) Unwrap() error { return ErrResourceBusy }

type AgentConcurrency struct {
	AgentID       string `json:"agentId"`
	MaxModelCalls int    `json:"maxModelCalls"`
	MaxToolCalls  int    `json:"maxToolCalls"`
}
type PortfolioPolicy struct {
	Revision               int64              `json:"revision"`
	Enabled                bool               `json:"enabled"`
	MaxActiveTasks         int                `json:"maxActiveTasks"`
	DefaultAgentModelCalls int                `json:"defaultAgentModelCalls"`
	DefaultAgentToolCalls  int                `json:"defaultAgentToolCalls"`
	Agents                 []AgentConcurrency `json:"agents"`
	AgingSeconds           int                `json:"agingSeconds"`
}

func defaultPortfolioPolicy() PortfolioPolicy {
	return PortfolioPolicy{Agents: []AgentConcurrency{}, AgingSeconds: 60}
}
func (p PortfolioPolicy) validate() error {
	if p.MaxActiveTasks < 0 || p.MaxActiveTasks > 1000 || p.DefaultAgentModelCalls < 0 || p.DefaultAgentModelCalls > 1000 || p.DefaultAgentToolCalls < 0 || p.DefaultAgentToolCalls > 1000 || p.AgingSeconds < 1 || p.AgingSeconds > 86400 || len(p.Agents) > 1000 {
		return fmt.Errorf("%w: invalid portfolio limits", ErrInvalidState)
	}
	seen := map[string]bool{}
	for _, a := range p.Agents {
		if a.AgentID == "" || seen[a.AgentID] || a.MaxModelCalls < 0 || a.MaxModelCalls > 1000 || a.MaxToolCalls < 0 || a.MaxToolCalls > 1000 {
			return fmt.Errorf("%w: invalid or duplicate agent limit", ErrInvalidState)
		}
		seen[a.AgentID] = true
	}
	return nil
}
func (p PortfolioPolicy) limit(agent, kind string) int {
	limit := p.DefaultAgentToolCalls
	if kind == "model" {
		limit = p.DefaultAgentModelCalls
	}
	for _, a := range p.Agents {
		if a.AgentID == agent {
			if kind == "model" {
				return a.MaxModelCalls
			}
			return a.MaxToolCalls
		}
	}
	return limit
}

type PortfolioCounts struct {
	Pending         int `json:"pending"`
	Active          int `json:"active"`
	WaitingReview   int `json:"waitingReview"`
	WaitingApproval int `json:"waitingApproval"`
	Unknown         int `json:"unknown"`
	Completed       int `json:"completed"`
	Failed          int `json:"failed"`
	Cancelled       int `json:"cancelled"`
}
type PortfolioBlocker struct {
	Code           string     `json:"code"`
	Detail         string     `json:"detail"`
	NextEligibleAt *time.Time `json:"nextEligibleAt,omitempty"`
}
type PortfolioRun struct {
	Run      mission.Run        `json:"run"`
	Counts   PortfolioCounts    `json:"counts"`
	Blocking []PortfolioBlocker `json:"blocking"`
}
type PortfolioProject struct {
	Project     mission.Project    `json:"project"`
	Scheduling  mission.Scheduling `json:"scheduling"`
	FairService int64              `json:"fairService"`
	Runs        []PortfolioRun     `json:"runs"`
}
type PortfolioTotals struct {
	Projects           int   `json:"projects"`
	Runs               int   `json:"runs"`
	PendingTasks       int   `json:"pendingTasks"`
	ActiveTasks        int   `json:"activeTasks"`
	WaitingReviewTasks int   `json:"waitingReviewTasks"`
	UnknownOperations  int   `json:"unknownOperations"`
	Tokens             int64 `json:"tokens"`
	ModelCalls         int64 `json:"modelCalls"`
	ToolCalls          int64 `json:"toolCalls"`
}
type PortfolioOverview struct {
	Policy           PortfolioPolicy    `json:"policy"`
	Totals           PortfolioTotals    `json:"totals"`
	Projects         []PortfolioProject `json:"projects"`
	Truncated        bool               `json:"truncated"`
	GeneratedAt      time.Time          `json:"generatedAt"`
	ConcurrencyScope string             `json:"concurrencyScope"`
}
type PortfolioRunAction struct {
	ProjectID        string `json:"projectId"`
	RunID            string `json:"runId"`
	ExpectedRevision int64  `json:"expectedRevision"`
}
type PortfolioActionResult struct {
	ProjectID string       `json:"projectId"`
	RunID     string       `json:"runId"`
	Status    string       `json:"status"`
	Run       *mission.Run `json:"run,omitempty"`
	Error     string       `json:"error,omitempty"`
}
