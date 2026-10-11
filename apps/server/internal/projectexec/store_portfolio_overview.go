// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math"
	"time"
)

// PortfolioOverview reads a tenant-scoped snapshot. Monetary cost is deliberately
// absent: model prices and unreported usage cannot be inferred from task states.
func (s *Store) PortfolioOverview(ctx context.Context, tenant, space string, limit int) (PortfolioOverview, error) {
	out := PortfolioOverview{Projects: []PortfolioProject{}, GeneratedAt: s.now(), ConcurrencyScope: "tenant"}
	limit = boundedLimit(limit)
	if limit > 200 {
		limit = 200
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	var n int
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM tenants WHERE id=?`), tenant).Scan(&n); err != nil {
		return out, err
	}
	if n != 1 {
		return out, ErrNotFound
	}
	out.Policy, err = s.portfolioPolicy(ctx, tx, tenant)
	if err != nil {
		return out, err
	}
	draining, err := s.tenantDraining(ctx, tx, tenant)
	if err != nil {
		return out, err
	}
	activeTenant, err := s.activeTenantTasks(ctx, tx, tenant)
	if err != nil {
		return out, err
	}
	filter := ` WHERE p.tenant_id=?`
	args := []any{tenant}
	if space != "" {
		filter += ` AND p.space_id=?`
		args = append(args, space)
	}
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_projects p`+filter), args...).Scan(&out.Totals.Projects); err != nil {
		return out, err
	}
	projectArgs := append(append([]any{}, args...), limit+1)
	rows, err := tx.QueryContext(ctx, s.rebind(`SELECT p.project_json,COALESCE(service.virtual_finish,0) FROM execution_projects p LEFT JOIN execution_portfolio_service service ON service.project_id=p.id AND service.tenant_id=p.tenant_id`+filter+` ORDER BY p.updated_at DESC,p.id LIMIT ?`), projectArgs...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var raw string
		var service int64
		if err = rows.Scan(&raw, &service); err != nil {
			rows.Close()
			return out, err
		}
		var p mission.Project
		if err = json.Unmarshal([]byte(raw), &p); err != nil {
			rows.Close()
			return out, err
		}
		out.Projects = append(out.Projects, PortfolioProject{Project: p, Scheduling: p.Config.Scheduling.Normalized(), FairService: service, Runs: []PortfolioRun{}})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if len(out.Projects) > limit {
		out.Truncated = true
		out.Projects = out.Projects[:limit]
	}
	// Totals cover every project selected by the filter, even when display rows
	// are paged. The underlying counters include conservative lost-call charges.
	rows, err = tx.QueryContext(ctx, s.rebind(`SELECT r.run_json FROM execution_runs r JOIN execution_projects p ON p.id=r.project_id AND p.tenant_id=r.tenant_id`+filter), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return out, err
		}
		var r mission.Run
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			rows.Close()
			return out, err
		}
		if r.Tokens < 0 || r.ModelCalls < 0 || r.ToolCalls < 0 || r.Tokens > math.MaxInt64-out.Totals.Tokens || int64(r.ModelCalls) > math.MaxInt64-out.Totals.ModelCalls || int64(r.ToolCalls) > math.MaxInt64-out.Totals.ToolCalls {
			return out, fmt.Errorf("portfolio usage counters exceed representable range")
		}
		out.Totals.Runs++
		out.Totals.Tokens += r.Tokens
		out.Totals.ModelCalls += int64(r.ModelCalls)
		out.Totals.ToolCalls += int64(r.ToolCalls)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, s.rebind(`SELECT t.status,t.lease_until FROM execution_tasks t JOIN execution_projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id`+filter), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var status string
		var lease sql.NullString
		if err = rows.Scan(&status, &lease); err != nil {
			rows.Close()
			return out, err
		}
		switch status {
		case "pending":
			out.Totals.PendingTasks++
		case "waiting_review":
			out.Totals.WaitingReviewTasks++
		case "running", "verifying":
			if lease.Valid && lease.String > stamp(out.GeneratedAt) {
				out.Totals.ActiveTasks++
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_operations operation JOIN execution_projects p ON p.id=operation.project_id AND p.tenant_id=operation.tenant_id`+filter+` AND operation.status='unknown'`), args...).Scan(&out.Totals.UnknownOperations); err != nil {
		return out, err
	}
	heads := []fairHead{}
	if out.Policy.Enabled && !draining {
		heads, err = s.fairHeads(ctx, tx, tenant)
		if err != nil {
			return out, err
		}
		orderFairHeads(heads, out.GeneratedAt, out.Policy.AgingSeconds)
	}
	resourceUsage, resourceOwners, err := s.portfolioResources(ctx, tx, tenant)
	if err != nil {
		return out, err
	}
	for i := range out.Projects {
		entry := &out.Projects[i]
		rows, err = tx.QueryContext(ctx, s.rebind(`SELECT run_json FROM execution_runs WHERE tenant_id=? AND project_id=? ORDER BY CASE WHEN status IN ('pending','running','paused','waiting_review','waiting_approval','blocked') THEN 0 ELSE 1 END,created_at DESC,id LIMIT 26`), tenant, entry.Project.ID)
		if err != nil {
			return out, err
		}
		runs, err := decodeRows[mission.Run](rows)
		if err != nil {
			return out, err
		}
		if len(runs) > 25 {
			out.Truncated = true
			runs = runs[:25]
		}
		for _, run := range runs {
			frozen, err := s.frozenProject(ctx, tx, tenant, entry.Project.ID, run.ID)
			if err != nil {
				return out, err
			}
			tasks, err := s.listTasks(ctx, tx, tenant, entry.Project.ID, run.ID)
			if err != nil {
				return out, err
			}
			state := PortfolioRun{Run: run, Blocking: []PortfolioBlocker{}}
			bySpec := map[string]mission.Task{}
			for _, task := range tasks {
				bySpec[task.Spec.ID] = task
				switch task.Status {
				case "pending":
					state.Counts.Pending++
				case "running", "verifying":
					if task.LeaseUntil != nil && task.LeaseUntil.After(out.GeneratedAt) {
						state.Counts.Active++
					}
				case "waiting_review":
					state.Counts.WaitingReview++
				case "waiting_approval":
					state.Counts.WaitingApproval++
				case "unknown":
					state.Counts.Unknown++
				case "completed":
					state.Counts.Completed++
				case "failed":
					state.Counts.Failed++
				case "cancelled":
					state.Counts.Cancelled++
				}
			}
			add := func(code, detail string) {
				state.Blocking = append(state.Blocking, PortfolioBlocker{Code: code, Detail: detail})
			}
			if draining {
				add("tenant_draining", "Tenant deletion has fenced execution; outstanding effects require operator resolution")
			}
			if run.Status != "pending" && run.Status != "running" {
				add("run_"+run.Status, "Run state requires an explicit control or review before more task dispatch")
			}
			if state.Counts.WaitingReview > 0 {
				add("human_review", fmt.Sprintf("%d immutable task outputs await acceptance", state.Counts.WaitingReview))
			}
			if state.Counts.WaitingApproval > 0 {
				add("external_approval", fmt.Sprintf("%d tasks await approval before external dispatch", state.Counts.WaitingApproval))
			}
			if state.Counts.Unknown > 0 {
				add("unknown_effect", fmt.Sprintf("%d tasks need inspection or human resolution", state.Counts.Unknown))
			}
			ready := 0
			dependencies := 0
			for _, task := range tasks {
				if task.Status != "pending" {
					continue
				}
				blocked := false
				for _, dep := range task.Spec.DependsOn {
					if bySpec[dep].Status != "completed" {
						blocked = true
						break
					}
				}
				if blocked {
					dependencies++
				} else {
					ready++
				}
			}
			if dependencies > 0 {
				add("dependencies", fmt.Sprintf("%d pending tasks await completed dependency artifacts", dependencies))
			}
			if ready > 0 && out.Policy.Enabled && out.Policy.MaxActiveTasks > 0 && activeTenant >= out.Policy.MaxActiveTasks {
				add("tenant_active_slots", fmt.Sprintf("Tenant has %d/%d leased task slots", activeTenant, out.Policy.MaxActiveTasks))
			}
			if ready > 0 && frozen.Config.Budget.MaxConcurrent > 0 && state.Counts.Active >= frozen.Config.Budget.MaxConcurrent {
				add("run_active_slots", fmt.Sprintf("Run has %d/%d leased task slots", state.Counts.Active, frozen.Config.Budget.MaxConcurrent))
			}
			if ready > 0 && out.Policy.Enabled && len(heads) > 0 && heads[0].projectID != entry.Project.ID {
				add("fairness_queue", "Another eligible project has the next weighted or aged claim opportunity")
			}

			if out.Policy.Enabled {
				reported := map[string]bool{}
				for _, task := range tasks {
					if task.Status != "running" && task.Status != "pending" {
						continue
					}
					kind := "model"
					if task.Status == "running" {
						cp, err := s.checkpoint(ctx, tx, scopeOf(entry.Project), run.ID, task.ID)
						if err != nil {
							return out, err
						}
						if cp.Decision != nil && cp.Decision.Done {
							continue
						}
						if cp.Decision != nil && cp.NextTool < len(cp.Decision.Tools) {
							kind = "tool"
						}
					}
					key := task.Spec.AgentID + "\x00" + kind
					usage := resourceUsage[key]
					limit := out.Policy.limit(task.Spec.AgentID, kind)
					if limit <= 0 || usage.Count < limit || reported[key] || resourceOwners[resourceOwnerKey(entry.Project.ID, run.ID, task.ID, kind)] {
						continue
					}
					reported[key] = true
					blocker := PortfolioBlocker{Code: "agent_" + kind + "_concurrency", Detail: fmt.Sprintf("Agent %s has %d/%d leased %s dispatch reservations", task.Spec.AgentID, usage.Count, limit, kind)}
					if !usage.Earliest.IsZero() {
						expiry := usage.Earliest
						blocker.NextEligibleAt = &expiry
					}
					state.Blocking = append(state.Blocking, blocker)
				}
			}
			budget := frozen.Config.Budget
			if budget.MaxTokens > 0 && run.Tokens >= budget.MaxTokens {
				add("token_budget", "Persisted token consumption has reached the frozen run budget")
			}
			if budget.MaxModelCalls > 0 && run.ModelCalls >= budget.MaxModelCalls {
				add("model_budget", "Persisted model calls have reached the frozen run budget")
			}
			if budget.MaxToolCalls > 0 && run.ToolCalls >= budget.MaxToolCalls {
				add("tool_budget", "Persisted tool calls have reached the frozen run budget")
			}
			if budget.MaxWallSeconds > 0 && out.GeneratedAt.Sub(run.CreatedAt) >= time.Duration(budget.MaxWallSeconds)*time.Second {
				add("wall_budget", "Frozen wall time budget has elapsed")
			}
			if ready > 0 && len(state.Blocking) == 0 {
				add("awaiting_worker", "Ready work awaits a server worker; this view does not reserve a slot")
			}
			if state.Counts.Active > 0 && len(state.Blocking) == 0 {
				add("in_progress", "Live leased workers are executing or verifying task branches")
			}
			entry.Runs = append(entry.Runs, state)
		}
	}
	if err = tx.Commit(); err != nil {
		return out, err
	}
	return out, nil
}

type portfolioResourceUsage struct {
	Count    int
	Earliest time.Time
}

func resourceOwnerKey(project, run, task, kind string) string {
	return project + "\x00" + run + "\x00" + task + "\x00" + kind
}
func (s *Store) portfolioResources(ctx context.Context, q sqlReader, tenant string) (map[string]portfolioResourceUsage, map[string]bool, error) {
	usage := map[string]portfolioResourceUsage{}
	owners := map[string]bool{}
	rows, err := q.QueryContext(ctx, s.rebind(`SELECT resource.agent_id,resource.kind,resource.project_id,resource.run_id,resource.task_id,t.lease_until FROM execution_resource_reservations resource JOIN execution_tasks t ON t.tenant_id=resource.tenant_id AND t.project_id=resource.project_id AND t.run_id=resource.run_id AND t.id=resource.task_id JOIN execution_runs r ON r.tenant_id=t.tenant_id AND r.project_id=t.project_id AND r.id=t.run_id WHERE resource.tenant_id=? AND resource.fence=t.fence AND t.status IN ('running','verifying') AND t.lease_until>?`), tenant, stamp(s.now()))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var agent, kind, project, run, task, lease string
		if err = rows.Scan(&agent, &kind, &project, &run, &task, &lease); err != nil {
			return nil, nil, err
		}
		until, err := time.Parse(time.RFC3339Nano, lease)
		if err != nil {
			return nil, nil, err
		}
		key := agent + "\x00" + kind
		state := usage[key]
		state.Count++
		if state.Earliest.IsZero() || until.Before(state.Earliest) {
			state.Earliest = until
		}
		usage[key] = state
		owners[resourceOwnerKey(project, run, task, kind)] = true
	}
	return usage, owners, rows.Err()
}
