// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

// ApplyPortfolioActions commits each control independently. It never claims to
// roll back a cancellation already delivered to a live model or runner request.
func (e *Engine) ApplyPortfolioActions(ctx context.Context, tenant, action string, items []PortfolioRunAction, beforeAction ...func(context.Context, PortfolioRunAction) error) ([]PortfolioActionResult, error) {
	if action != "pause" && action != "resume" && action != "cancel" {
		return nil, fmt.Errorf("%w: action must be pause, resume or cancel", ErrInvalidState)
	}
	if len(items) == 0 || len(items) > 100 {
		return nil, fmt.Errorf("%w: select 1 to 100 runs", ErrInvalidState)
	}
	seen := map[string]bool{}
	for _, item := range items {
		key := item.ProjectID + "\x00" + item.RunID
		if item.ProjectID == "" || item.RunID == "" || item.ExpectedRevision < 1 || seen[key] {
			return nil, fmt.Errorf("%w: unique scoped runs and expected revisions required", ErrInvalidState)
		}
		seen[key] = true
	}
	out := make([]PortfolioActionResult, 0, len(items))
	for _, item := range items {
		result := PortfolioActionResult{ProjectID: item.ProjectID, RunID: item.RunID, Status: "applied"}
		var run mission.Run
		var err error
		for _, guard := range beforeAction {
			if guard != nil {
				err = guard(ctx, item)
				if err != nil {
					break
				}
			}
		}
		if err == nil {
			switch action {
			case "pause":
				run, err = e.Pause(ctx, tenant, item.ProjectID, item.RunID, item.ExpectedRevision)
			case "resume":
				run, err = e.Resume(ctx, tenant, item.ProjectID, item.RunID, item.ExpectedRevision)
			case "cancel":
				run, err = e.Cancel(ctx, tenant, item.ProjectID, item.RunID, item.ExpectedRevision)
			}
		}
		if err == nil {
			result.Run = &run
		} else {
			result.Error = err.Error()
			switch {
			case errors.Is(err, ErrConflict):
				result.Status = "conflict"
			case errors.Is(err, ErrNotFound):
				result.Status = "not_found"
			case errors.Is(err, ErrInvalidState), errors.Is(err, ErrTenantDraining):
				result.Status = "invalid_state"
			default:
				result.Status = "failed"
			}
		}
		out = append(out, result)
	}
	return out, nil
}
