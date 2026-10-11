// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"math"
	"sort"
	"time"
)

func (s *Store) lockTenant(ctx context.Context, tx *sql.Tx, tenant string) error {
	result, err := tx.ExecContext(ctx, s.rebind(`UPDATE tenants SET id=id WHERE id=?`), tenant)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) portfolioPolicy(ctx context.Context, q sqlReader, tenant string) (PortfolioPolicy, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT policy_json FROM execution_portfolio_policies WHERE tenant_id=?`), tenant).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultPortfolioPolicy(), nil
	}
	if err != nil {
		return PortfolioPolicy{}, err
	}
	var p PortfolioPolicy
	err = json.Unmarshal([]byte(raw), &p)
	return p, err
}
func (s *Store) GetPortfolioPolicy(ctx context.Context, tenant string) (PortfolioPolicy, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM tenants WHERE id=?`), tenant).Scan(&n); err != nil {
		return PortfolioPolicy{}, err
	}
	if n != 1 {
		return PortfolioPolicy{}, ErrNotFound
	}
	return s.portfolioPolicy(ctx, s.db, tenant)
}
func (s *Store) UpdatePortfolioPolicy(ctx context.Context, tenant string, expectedRevision int64, p PortfolioPolicy) (PortfolioPolicy, error) {
	if p.AgingSeconds == 0 {
		p.AgingSeconds = 60
	}
	if p.Agents == nil {
		p.Agents = []AgentConcurrency{}
	}
	if err := p.validate(); err != nil {
		return PortfolioPolicy{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PortfolioPolicy{}, err
	}
	defer tx.Rollback()
	if err = s.lockTenant(ctx, tx, tenant); err != nil {
		return PortfolioPolicy{}, err
	}
	if err = s.RequireTenantActive(ctx, tx, tenant); err != nil {
		return PortfolioPolicy{}, err
	}
	old, err := s.portfolioPolicy(ctx, tx, tenant)
	if err != nil {
		return PortfolioPolicy{}, err
	}
	if old.Revision != expectedRevision {
		return PortfolioPolicy{}, ErrConflict
	}
	p.Revision = old.Revision + 1
	sort.Slice(p.Agents, func(i, j int) bool { return p.Agents[i].AgentID < p.Agents[j].AgentID })
	raw, err := encode(p)
	if err != nil {
		return PortfolioPolicy{}, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_portfolio_policies(tenant_id,revision,policy_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json,updated_at=excluded.updated_at`), tenant, p.Revision, raw, stamp(s.now()))
	if err != nil {
		return PortfolioPolicy{}, err
	}
	if err = tx.Commit(); err != nil {
		return PortfolioPolicy{}, err
	}
	return p, nil
}
func (s *Store) UpdateProjectScheduling(ctx context.Context, tenant, pid string, revision int64, policy mission.Scheduling) (mission.Project, error) {
	if err := policy.Validate(); err != nil {
		return mission.Project{}, fmt.Errorf("%w: %v", ErrInvalidState, err)
	}
	policy = policy.Normalized()
	var out mission.Project
	err := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		if err := s.RequireTenantActive(ctx, tx, tenant); err != nil {
			return err
		}
		p, err := s.project(ctx, tx, tenant, pid)
		if err != nil {
			return err
		}
		if p.Revision != revision {
			return ErrConflict
		}
		p.Config.Scheduling = policy
		p.Revision++
		p.UpdatedAt = s.now()
		raw, err := encode(p)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET revision=?,project_json=?,updated_at=? WHERE tenant_id=? AND id=?`), p.Revision, raw, stamp(p.UpdatedAt), tenant, pid); err != nil {
			return err
		}
		out = p
		return s.event(ctx, tx, scopeOf(p), "", "", "project.scheduling_updated", map[string]any{"revision": p.Revision, "scheduling": policy})
	})
	return out, err
}

type fairHead struct {
	projectID string
	created   time.Time
	finish    int64
	last      time.Time
}

func (s *Store) activeTenantTasks(ctx context.Context, q sqlReader, tenant string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_tasks t JOIN execution_runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id WHERE t.tenant_id=? AND t.status IN ('running','verifying') AND t.lease_until>?`), tenant, stamp(s.now())).Scan(&n)
	return n, err
}

// Saturated runs are excluded before project ordering, keeping independent
// work runnable even when a higher-ranked project's current run is busy.
func (s *Store) fairHeads(ctx context.Context, tx *sql.Tx, tenant string) ([]fairHead, error) {
	rows, err := tx.QueryContext(ctx, s.rebind(`SELECT p.project_json,r.project_json,MIN(t.created_at),COALESCE(service.virtual_finish,0),COALESCE(service.last_dispatched_at,''),(SELECT COUNT(*) FROM execution_tasks active WHERE active.tenant_id=p.tenant_id AND active.project_id=p.id AND active.run_id=r.id AND active.status IN ('running','verifying') AND active.lease_until>?) FROM execution_tasks t JOIN execution_runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id AND r.project_id=t.project_id JOIN execution_projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id LEFT JOIN execution_portfolio_service service ON service.project_id=p.id AND service.tenant_id=p.tenant_id WHERE t.tenant_id=? AND r.status IN ('pending','running') AND ((t.status='pending' AND NOT EXISTS (SELECT 1 FROM execution_task_dependencies d JOIN execution_tasks dep ON dep.id=d.dependency_id AND dep.run_id=d.run_id AND dep.tenant_id=d.tenant_id AND dep.project_id=d.project_id WHERE d.tenant_id=t.tenant_id AND d.project_id=t.project_id AND d.run_id=t.run_id AND d.task_id=t.id AND dep.status!='completed')) OR (t.status IN ('running','verifying') AND (t.lease_until IS NULL OR t.lease_until<=?))) GROUP BY p.id,p.tenant_id,p.project_json,r.id,r.project_json,service.virtual_finish,service.last_dispatched_at`), stamp(s.now()), tenant, stamp(s.now()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	heads := map[string]fairHead{}
	for rows.Next() {
		var projectRaw, frozenRaw, created, last string
		var finish int64
		var active int
		if err = rows.Scan(&projectRaw, &frozenRaw, &created, &finish, &last, &active); err != nil {
			return nil, err
		}
		var p, frozen mission.Project
		if err = json.Unmarshal([]byte(projectRaw), &p); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(frozenRaw), &frozen); err != nil {
			return nil, err
		}
		if frozen.Config.Budget.MaxConcurrent > 0 && active >= frozen.Config.Budget.MaxConcurrent {
			continue
		}
		createdAt, err := time.Parse(time.RFC3339Nano, created)
		if err != nil {
			return nil, err
		}
		h := fairHead{projectID: p.ID, created: createdAt, finish: finish}
		if last != "" {
			h.last, err = time.Parse(time.RFC3339Nano, last)
			if err != nil {
				return nil, err
			}
		}
		if old, ok := heads[p.ID]; !ok || h.created.Before(old.created) {
			heads[p.ID] = h
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := make([]fairHead, 0, len(heads))
	for _, h := range heads {
		out = append(out, h)
	}
	return out, nil
}

func orderFairHeads(heads []fairHead, now time.Time, agingSeconds int) {
	cutoff := now.Add(-time.Duration(agingSeconds) * time.Second)
	aged := func(h fairHead) bool { return !h.created.After(cutoff) && (h.last.IsZero() || !h.last.After(cutoff)) }
	sort.Slice(heads, func(i, j int) bool {
		ai, aj := aged(heads[i]), aged(heads[j])
		if ai != aj {
			return ai
		}
		if ai && !heads[i].created.Equal(heads[j].created) {
			return heads[i].created.Before(heads[j].created)
		}
		if heads[i].finish != heads[j].finish {
			return heads[i].finish < heads[j].finish
		}
		if !heads[i].created.Equal(heads[j].created) {
			return heads[i].created.Before(heads[j].created)
		}
		return heads[i].projectID < heads[j].projectID
	})
}
func (s *Store) portfolioClaimAllowed(ctx context.Context, tx *sql.Tx, tenant, pid string) (bool, error) {
	policy, err := s.portfolioPolicy(ctx, tx, tenant)
	if err != nil {
		return false, err
	}
	if !policy.Enabled {
		return true, nil
	}
	if policy.MaxActiveTasks > 0 {
		active, err := s.activeTenantTasks(ctx, tx, tenant)
		if err != nil {
			return false, err
		}
		if active >= policy.MaxActiveTasks {
			return false, nil
		}
	}
	heads, err := s.fairHeads(ctx, tx, tenant)
	if err != nil {
		return false, err
	}
	orderFairHeads(heads, s.now(), policy.AgingSeconds)
	return len(heads) > 0 && heads[0].projectID == pid, nil
}
func (s *Store) recordPortfolioClaim(ctx context.Context, tx *sql.Tx, tenant, pid string) error {
	policy, err := s.portfolioPolicy(ctx, tx, tenant)
	if err != nil {
		return err
	}
	if !policy.Enabled {
		return nil
	}
	p, err := s.project(ctx, tx, tenant, pid)
	if err != nil {
		return err
	}
	stride, err := p.Config.Scheduling.ServiceStride()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidState, err)
	}
	var finish int64
	err = tx.QueryRowContext(ctx, s.rebind(`SELECT virtual_finish FROM execution_portfolio_service WHERE tenant_id=? AND project_id=?`), tenant, pid).Scan(&finish)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return err
	}
	if finish > math.MaxInt64-stride {
		return fmt.Errorf("%w: virtual service overflow", ErrInvalidState)
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_portfolio_service(tenant_id,project_id,virtual_finish,dispatch_count,last_dispatched_at) VALUES(?,?,?,1,?) ON CONFLICT(tenant_id,project_id) DO UPDATE SET virtual_finish=excluded.virtual_finish,dispatch_count=execution_portfolio_service.dispatch_count+1,last_dispatched_at=excluded.last_dispatched_at`), tenant, pid, finish+stride, stamp(s.now()))
	return err
}
func (s *Store) acquireResource(ctx context.Context, tx *sql.Tx, ref FenceRequest, task mission.Task, kind string) error {
	policy, err := s.portfolioPolicy(ctx, tx, ref.Scope.TenantID)
	if err != nil {
		return err
	}
	limit := policy.limit(task.Spec.AgentID, kind)
	if !policy.Enabled {
		limit = 0
	}
	var owned int
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_resource_reservations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND kind=? AND fence=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, kind, ref.Fence).Scan(&owned); err != nil {
		return err
	}
	if owned > 0 {
		return nil
	}
	var active int
	var earliest sql.NullString
	err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*),MIN(t.lease_until) FROM execution_resource_reservations resource JOIN execution_tasks t ON t.id=resource.task_id AND t.tenant_id=resource.tenant_id AND t.project_id=resource.project_id AND t.run_id=resource.run_id JOIN execution_runs r ON r.id=t.run_id AND r.tenant_id=t.tenant_id WHERE resource.tenant_id=? AND resource.agent_id=? AND resource.kind=? AND resource.fence=t.fence AND t.status IN ('running','verifying') AND t.lease_until>?`), ref.Scope.TenantID, task.Spec.AgentID, kind, stamp(s.now())).Scan(&active, &earliest)
	if err != nil {
		return err
	}
	if limit > 0 && active >= limit {
		retry := s.now().Add(time.Second)
		if earliest.Valid {
			if parsed, e := time.Parse(time.RFC3339Nano, earliest.String); e == nil {
				retry = parsed
			}
		}
		return &ResourceBusyError{Code: "agent_" + kind + "_concurrency", RetryAt: retry}
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_resource_reservations(tenant_id,project_id,run_id,task_id,agent_id,kind,fence,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,run_id,task_id,kind) DO UPDATE SET project_id=excluded.project_id,run_id=excluded.run_id,agent_id=excluded.agent_id,fence=excluded.fence,created_at=excluded.created_at`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, task.Spec.AgentID, kind, ref.Fence, stamp(s.now()))
	return err
}
func (s *Store) releaseResource(ctx context.Context, tx *sql.Tx, ref FenceRequest, kind string) error {
	_, err := tx.ExecContext(ctx, s.rebind(`DELETE FROM execution_resource_reservations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND kind=? AND fence=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, kind, ref.Fence)
	return err
}

// AcquireToolResource gates safe read re-dispatch after a worker restart. New
// operations acquire the same reservation atomically in StartOperation.
func (s *Store) AcquireToolResource(ctx context.Context, ref FenceRequest) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		task, _, _, err := s.fenced(ctx, tx, ref)
		if err != nil {
			return err
		}
		return s.acquireResource(ctx, tx, ref, task, "tool")
	})
}
