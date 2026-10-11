// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func enablePortfolio(t *testing.T, s *Store, tenant string, p PortfolioPolicy) PortfolioPolicy {
	t.Helper()
	p.Enabled = true
	if p.AgingSeconds == 0 {
		p.AgingSeconds = 60
	}
	out, err := s.UpdatePortfolioPolicy(context.Background(), tenant, 0, p)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func manyPortfolioTasks(n int) []mission.TaskSpec {
	out := make([]mission.TaskSpec, n)
	for i := range out {
		out[i] = projectFixture().Plan.Tasks[0]
		out[i].ID = fmt.Sprintf("task-%03d", i)
	}
	return out
}
func TestPortfolioWeightedServicePersistsAcrossRestart(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{MaxActiveTasks: 1, AgingSeconds: 86400})
	p1 := projectFixture()
	p1.Plan.Tasks = manyPortfolioTasks(100)
	p1.Config.Budget.MaxConcurrent = 1
	p1.Config.Scheduling = mission.Scheduling{Weight: 1}
	p1, _ = createFixture(t, s, p1)
	p2 := projectFixture()
	p2.Plan.Tasks = manyPortfolioTasks(100)
	p2.Config.Budget.MaxConcurrent = 1
	p2.Config.Scheduling = mission.Scheduling{Weight: 3}
	p2, _ = createFixture(t, s, p2)
	counts := map[string]int{}
	for i := 0; i < 80; i++ {
		if i == 40 {
			s = NewStore(s.db, s.dialect, s.rebind)
		}
		a, err := s.ClaimTask(ctx, "weighted-worker", time.Minute)
		if err != nil || a == nil {
			t.Fatalf("claim %d: %v %v", i, a, err)
		}
		counts[a.Scope.ProjectID]++
		if err = s.FailTask(ctx, assignmentFence(*a), "finished admission test"); err != nil {
			t.Fatal(err)
		}
	}
	if counts[p1.ID] < 19 || counts[p1.ID] > 21 || counts[p2.ID] < 59 || counts[p2.ID] > 61 {
		t.Fatalf("expected durable 1:3 service, got %+v", counts)
	}
	var dispatches int
	if err := s.db.QueryRow(`SELECT SUM(dispatch_count) FROM execution_portfolio_service WHERE tenant_id='tenant-a'`).Scan(&dispatches); err != nil || dispatches != 80 {
		t.Fatalf("dispatches=%d err=%v", dispatches, err)
	}
}
func TestPortfolioAgingAndSaturatedRunsCannotStarveOtherProjects(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{AgingSeconds: 10})
	low := projectFixture()
	low.Config.Scheduling = mission.Scheduling{Priority: -20, Weight: 1}
	low, _ = createFixture(t, s, low)
	clock = clock.Add(20 * time.Second)
	high := projectFixture()
	high.Config.Scheduling = mission.Scheduling{Priority: 20, Weight: 100}
	high.Plan.Tasks = manyPortfolioTasks(2)
	high.Config.Budget.MaxConcurrent = 1
	high, _ = createFixture(t, s, high)
	if _, err := s.db.Exec(`INSERT INTO execution_portfolio_service(tenant_id,project_id,virtual_finish,dispatch_count,last_dispatched_at) VALUES('tenant-a',?,999999999,1,?)`, low.ID, stamp(clock.Add(-20*time.Second))); err != nil {
		t.Fatal(err)
	}
	a, err := s.ClaimTask(ctx, "aging-worker", time.Minute)
	if err != nil || a == nil || a.Scope.ProjectID != low.ID {
		t.Fatalf("old low-priority project starved: %+v %v", a, err)
	}
	b, err := s.ClaimTask(ctx, "high-worker", time.Minute)
	if err != nil || b == nil || b.Scope.ProjectID != high.ID {
		t.Fatalf("high project: %+v %v", b, err)
	}
	// A second run in the lower-weight project is independently eligible while
	// the high project's only run is at its frozen concurrency limit.
	if _, err = s.CreateRun(ctx, "tenant-a", low.ID, "another-base"); err != nil {
		t.Fatal(err)
	}
	c, err := s.ClaimTask(ctx, "next-worker", time.Minute)
	if err != nil || c == nil || c.Scope.ProjectID != low.ID {
		t.Fatalf("saturated higher rank starved eligible run: %+v %v", c, err)
	}
}
func TestPortfolioTenantSlotsAreAtomicAcrossCompetingProjects(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{MaxActiveTasks: 2})
	for i := 0; i < 5; i++ {
		p := projectFixture()
		p.Config.Budget.MaxConcurrent = 1
		createFixture(t, s, p)
	}
	var wg sync.WaitGroup
	var claims atomic.Int64
	failures := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a, err := s.ClaimTask(ctx, fmt.Sprintf("competing-%d", i), time.Minute)
			if err != nil {
				failures <- err
			}
			if a != nil {
				claims.Add(1)
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if claims.Load() != 2 {
		t.Fatalf("tenant admitted %d tasks, limit2", claims.Load())
	}
	policy, err := s.GetPortfolioPolicy(ctx, "tenant-a")
	if err != nil {
		t.Fatal(err)
	}
	policy.MaxActiveTasks = 1
	if _, err = s.UpdatePortfolioPolicy(ctx, "tenant-a", policy.Revision, policy); err != nil {
		t.Fatal(err)
	}
	a, err := s.ClaimTask(ctx, "policy-lowered", time.Minute)
	if err != nil || a != nil {
		t.Fatalf("lowering limit dispatched or interrupted work: %+v %v", a, err)
	}
}
func TestPortfolioModelAndToolLimitsReserveBeforeDispatch(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{DefaultAgentModelCalls: 1, DefaultAgentToolCalls: 1})
	createFixture(t, s, projectFixture())
	createFixture(t, s, projectFixture())
	first, ref1 := claimFixture(t, s)
	second, ref2 := claimFixture(t, s)
	if _, err := s.ReserveDecisionBudget(ctx, ref1, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReserveDecisionBudget(ctx, ref2, 10); !errors.Is(err, ErrResourceBusy) {
		t.Fatalf("second model bypassed gate: %v", err)
	}
	run, err := s.GetRun(ctx, second.Scope.TenantID, second.Scope.ProjectID, second.Run.ID)
	if err != nil || run.ModelCalls != 0 || run.Tokens != 0 {
		t.Fatalf("blocked model spent budget: %+v %v", run, err)
	}
	call := mission.ToolCall{ID: "write", Name: "write", Effect: "workspace_write", Arguments: json.RawMessage(`{"path":"feature.go"}`)}
	decision := mission.Decision{Tokens: 3, Message: mission.Message{"role": "assistant", "content": "write"}, Tools: []mission.ToolCall{call}}
	cp1, err := s.RecordModelDecision(ctx, ref1, 0, decision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReserveDecisionBudget(ctx, ref2, 10); err != nil {
		t.Fatalf("released model slot blocked: %v", err)
	}
	cp2, err := s.RecordModelDecision(ctx, ref2, 0, decision)
	if err != nil {
		t.Fatal(err)
	}
	op1, _, err := s.BeginOperation(ctx, ref1, cp1.ID, call)
	if err != nil {
		t.Fatal(err)
	}
	op2, _, err := s.BeginOperation(ctx, ref2, cp2.ID, call)
	if err != nil {
		t.Fatal(err)
	}
	op1, err = s.StartOperation(ctx, ref1, op1.ID, op1.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.StartOperation(ctx, ref2, op2.ID, op2.Revision); !errors.Is(err, ErrResourceBusy) {
		t.Fatalf("second tool bypassed gate: %v", err)
	}
	got, err := s.GetOperation(ctx, second.Scope, second.Run.ID, op2.ID)
	if err != nil || got.Status != "prepared" || got.Revision != op2.Revision {
		t.Fatalf("blocked tool was dispatched: %+v %v", got, err)
	}
	if err = s.CompleteOperation(ctx, ref1, op1.ID, mission.ToolResult{Content: json.RawMessage(`{"written":true}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.StartOperation(ctx, ref2, op2.ID, op2.Revision); err != nil {
		t.Fatalf("released tool slot blocked: %v", err)
	}
	_ = first
}
func TestPortfolioOverviewActionsAndSchedulingRespectTenantAndRevision(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	p1, r1 := createFixture(t, s, projectFixture())
	p2, r2 := createFixture(t, s, projectFixture())
	other := projectFixture()
	other.TenantID = "tenant-b"
	other.SpaceID = "space-b"
	p3, r3 := createFixture(t, s, other)
	changed, err := s.UpdateProjectScheduling(ctx, "tenant-a", p1.ID, p1.Revision, mission.Scheduling{Priority: 10, Weight: 4})
	if err != nil || changed.Plan.Version != p1.Plan.Version {
		t.Fatalf("scheduling changed execution plan: %+v %v", changed, err)
	}
	frozen, err := s.GetRunProject(ctx, "tenant-a", p1.ID, r1.ID)
	if err != nil || frozen.Config.Scheduling.Priority != 0 {
		t.Fatalf("scheduling mutated frozen run: %+v %v", frozen, err)
	}
	if _, err = s.UpdateProjectScheduling(ctx, "tenant-a", p1.ID, p1.Revision, mission.Scheduling{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale scheduling: %v", err)
	}
	if _, err = s.UpdateProjectScheduling(ctx, "tenant-b", p1.ID, changed.Revision, mission.Scheduling{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant scheduling: %v", err)
	}
	policy := enablePortfolio(t, s, "tenant-a", PortfolioPolicy{MaxActiveTasks: 1})
	if _, err = s.UpdatePortfolioPolicy(ctx, "tenant-a", 0, policy); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale policy: %v", err)
	}
	e := NewEngine(s, callbackExecutor{}, newMemoryWorkspaces(), DefaultEngineConfig())
	results, err := e.ApplyPortfolioActions(ctx, "tenant-a", "pause", []PortfolioRunAction{{ProjectID: p1.ID, RunID: r1.ID, ExpectedRevision: r1.Revision}, {ProjectID: p2.ID, RunID: r2.ID, ExpectedRevision: r2.Revision + 99}, {ProjectID: p3.ID, RunID: r3.ID, ExpectedRevision: r3.Revision}})
	if err != nil || len(results) != 3 || results[0].Status != "applied" || results[1].Status != "conflict" || results[2].Status != "not_found" {
		t.Fatalf("batch promises/errors: %+v %v", results, err)
	}
	run, err := s.GetRun(ctx, "tenant-a", p1.ID, r1.ID)
	if err != nil || run.Status != "paused" {
		t.Fatalf("successful earlier control was rolled back: %+v %v", run, err)
	}
	overview, err := s.PortfolioOverview(ctx, "tenant-a", "", 1)
	if err != nil || overview.Totals.Projects != 2 || overview.Totals.Runs != 2 || len(overview.Projects) != 1 || !overview.Truncated {
		t.Fatalf("overview %+v %v", overview, err)
	}
	for _, item := range overview.Projects {
		if item.Project.TenantID != "tenant-a" {
			t.Fatal("portfolio leaked other tenant")
		}
	}
	if err = s.CancelTenant(ctx, "tenant-a"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.UpdatePortfolioPolicy(ctx, "tenant-a", policy.Revision, policy); !errors.Is(err, ErrTenantDraining) {
		t.Fatalf("policy reopened draining tenant: %v", err)
	}
	if _, err = s.UpdateProjectScheduling(ctx, "tenant-a", p2.ID, p2.Revision, mission.Scheduling{}); !errors.Is(err, ErrTenantDraining) {
		t.Fatalf("scheduling reopened draining tenant: %v", err)
	}
	a, err := s.ClaimTask(ctx, "remaining-tenant", time.Minute)
	if err != nil || a == nil || a.Scope.TenantID != "tenant-b" {
		t.Fatalf("drained tenant reclaimed/leaked: %+v %v", a, err)
	}
}

func TestPortfolioDispatchLimitsApplyWhenEnabledMidFlight(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	createFixture(t, s, projectFixture())
	createFixture(t, s, projectFixture())
	_, ref1 := claimFixture(t, s)
	second, ref2 := claimFixture(t, s)
	if _, err := s.ReserveDecisionBudget(ctx, ref1, 10); err != nil {
		t.Fatal(err)
	}
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{DefaultAgentModelCalls: 1})
	if _, err := s.ReserveDecisionBudget(ctx, ref2, 10); !errors.Is(err, ErrResourceBusy) {
		t.Fatalf("policy activation ignored existing dispatch: %v", err)
	}
	overview, err := s.PortfolioOverview(ctx, "tenant-a", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range overview.Projects {
		if p.Project.ID != second.Scope.ProjectID {
			continue
		}
		for _, r := range p.Runs {
			for _, b := range r.Blocking {
				if b.Code == "agent_model_concurrency" && b.NextEligibleAt != nil {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatal("portfolio did not explain model admission wait and lease recheck time")
	}
}

func TestPortfolioLeaseRecoveryReleasesOldIncarnationResources(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	clock := time.Now().UTC()
	s.now = func() time.Time { return clock }
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{DefaultAgentModelCalls: 1, MaxActiveTasks: 1})
	createFixture(t, s, projectFixture())
	createFixture(t, s, projectFixture())
	first, ref1 := claimFixture(t, s)
	if _, err := s.ReserveDecisionBudget(ctx, ref1, 10); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * time.Minute)
	recovered, err := s.ClaimTask(ctx, "new-incarnation", time.Minute)
	if err != nil || recovered == nil {
		t.Fatalf("expired resource held tenant slot: %+v %v", recovered, err)
	}
	if _, err = s.ReserveDecisionBudget(ctx, assignmentFence(*recovered), 10); err != nil {
		t.Fatalf("old resource held model slot after expiry: %v", err)
	}
	if _, err = s.RecordModelDecision(ctx, ref1, 0, finishedDecision()); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("late old model reply affected current resource: %v", err)
	}
	old, err := s.GetRun(ctx, first.Scope.TenantID, first.Scope.ProjectID, first.Run.ID)
	if err != nil || old.Tokens < 10 {
		t.Fatalf("unanswered call was refunded: %+v %v", old, err)
	}
}

func TestEngineWaitsForPortfolioDispatchSlotWithoutFailingTask(t *testing.T) {
	f := newEngineFixture(t, []mission.TaskSpec{fixtureTask("a"), fixtureTask("b")}, mission.Config{Budget: mission.Budget{MaxConcurrent: 2}})
	enablePortfolio(t, f.store, "tenant", PortfolioPolicy{DefaultAgentModelCalls: 1})
	first := f.claim(t, "first")
	second := f.claim(t, "second")
	if _, err := f.store.ReserveDecisionBudget(context.Background(), assignmentFence(first), 100); err != nil {
		t.Fatal(err)
	}
	advanced := make(chan struct{}, 1)
	x := callbackExecutor{advance: func(ctx context.Context, a mission.Assignment) (mission.Decision, error) {
		advanced <- struct{}{}
		f.workspaces.write(a.Task.BranchID, "report.txt", "done")
		return finishedDecision(), nil
	}}
	engine := f.engine(x)
	engine.config.PollInterval = 10 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- engine.process(ctx, assignmentFence(second), second) }()
	select {
	case <-advanced:
		t.Fatal("model dispatched before capacity")
	case <-time.After(60 * time.Millisecond):
	}
	if _, err := f.store.RecordModelDecision(context.Background(), assignmentFence(first), 0, finishedDecision()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	task, err := f.store.GetTask(context.Background(), second.Scope.TenantID, second.Scope.ProjectID, second.Run.ID, second.Task.ID)
	if err != nil || task.Status != "completed" {
		t.Fatalf("waiting task failed: %+v %v", task, err)
	}
}

func TestPortfolioPostgresTenantAndDispatchAdmission(t *testing.T) {
	s, _ := newPostgresStoreFixture(t)
	ctx := context.Background()
	enablePortfolio(t, s, "tenant-a", PortfolioPolicy{MaxActiveTasks: 2, DefaultAgentModelCalls: 1, DefaultAgentToolCalls: 1})
	for i := 0; i < 4; i++ {
		p := projectFixture()
		p.Config.Scheduling = mission.Scheduling{Weight: i + 1}
		createFixture(t, s, p)
	}
	var wg sync.WaitGroup
	claims := make(chan *mission.Assignment, 8)
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a, err := s.ClaimTask(ctx, fmt.Sprintf("pg-portfolio-%d", i), time.Minute)
			if err != nil {
				failures <- err
			}
			if a != nil {
				claims <- a
			}
		}(i)
	}
	wg.Wait()
	close(claims)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	assignments := []*mission.Assignment{}
	for a := range claims {
		assignments = append(assignments, a)
	}
	if len(assignments) != 2 {
		t.Fatalf("PostgreSQL tenant slots admitted %d", len(assignments))
	}
	var allowed, busy atomic.Int64
	errs := make(chan error, 2)
	for _, a := range assignments {
		wg.Add(1)
		go func(a *mission.Assignment) {
			defer wg.Done()
			_, err := s.ReserveDecisionBudget(ctx, assignmentFence(*a), 10)
			if err == nil {
				allowed.Add(1)
			} else if errors.Is(err, ErrResourceBusy) {
				busy.Add(1)
			} else {
				errs <- err
			}
		}(a)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if allowed.Load() != 1 || busy.Load() != 1 {
		t.Fatalf("PostgreSQL model slots allowed=%d busy=%d", allowed.Load(), busy.Load())
	}
	overview, err := s.PortfolioOverview(ctx, "tenant-a", "", 100)
	if err != nil || overview.Totals.ActiveTasks != 2 || len(overview.Projects) != 4 {
		t.Fatalf("PostgreSQL snapshot %+v %v", overview, err)
	}
	if err = s.CancelTenant(ctx, "tenant-a"); err != nil {
		t.Fatal(err)
	}
	a, err := s.ClaimTask(ctx, "post-drain", time.Minute)
	if err != nil || a != nil {
		t.Fatalf("PostgreSQL drained claim %+v %v", a, err)
	}
}
