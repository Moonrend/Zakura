package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func independentAdmittedContext(t *testing.T) (*handler, mission.Assignment, mission.Operation) {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant-independent-context")
	h := &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(d.DB, d.Dialect, d.Rebind)}
	ctx := context.Background()
	space, err := h.store.CreateSpace(ctx, "tenant-independent-context", Space{Name: "Context admission"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant-independent-context", SpaceID: space.ID, Name: "Bounded code references", Goal: "Use admitted frozen context only", Config: mission.Config{MaxTasks: 10, Budget: mission.Budget{MaxConcurrent: 1, MaxModelCalls: 20, MaxToolCalls: 20, MaxTokens: 10000}}, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "context", Title: "Read context", Prompt: "Understand implementation", AgentID: "fixture-agent", MaxAttempts: 2, Writes: []string{"src/**"}, Checks: []mission.CheckSpec{{ID: "source", Kind: "path_exists", Path: "src/api.go", Required: true}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	base := strings.Repeat("a", 64)
	if _, err = h.projects.CreateRun(ctx, p.TenantID, p.ID, base); err != nil {
		t.Fatal(err)
	}
	a, err := h.projects.ClaimTask(ctx, "context-admission-worker", time.Minute)
	if err != nil || a == nil {
		t.Fatalf("claim context task: %+v %v", a, err)
	}
	ref := projectexec.FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
	if err = h.projects.InitializeTaskBranch(ctx, ref, "fixture-context-branch", base); err != nil {
		t.Fatal(err)
	}
	cp, err := h.projects.GetCheckpoint(ctx, a.Scope, a.Run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.projects.ReserveDecisionBudget(ctx, ref, 100); err != nil {
		t.Fatal(err)
	}
	call := mission.ToolCall{ID: "context-call", Name: "project_context", Effect: "read", Arguments: json.RawMessage(`{"query":"implementation","maxBytes":512}`)}
	cp, err = h.projects.RecordModelDecision(ctx, ref, cp.Sequence, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := h.projects.BeginOperation(ctx, ref, cp.ID, call)
	if err != nil {
		t.Fatal(err)
	}
	op, err = h.projects.StartOperation(ctx, ref, op.ID, op.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a.Task, err = h.projects.GetTask(ctx, p.TenantID, p.ID, a.Run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	return h, *a, op
}

func TestProjectIndependentContextCurrentAdmissionRejectsStaleOrForgedWorkBeforeRPC(t *testing.T) {
	for _, scenario := range []string{"unknown operation", "different persisted arguments", "stale fence", "different worker", "different space", "expired lease", "run cancelled", "operation completed", "tenant draining"} {
		t.Run(scenario, func(t *testing.T) {
			h, a, op := independentAdmittedContext(t)
			ctx := context.Background()
			task, stored, err := h.contextAdmittedTask(ctx, a, op)
			if err != nil || task.BaseSnapshot != a.Task.BaseSnapshot || stored.ArgumentsHash != op.ArgumentsHash {
				t.Fatalf("actual admitted read rejected: task=%+v op=%+v err=%v", task, stored, err)
			}
			switch scenario {
			case "unknown operation":
				op.ID = "not-admitted"
			case "different persisted arguments":
				op.Call.Arguments = json.RawMessage(`{"query":"different","maxBytes":16000}`)
			case "stale fence":
				a.Task.Fence++
			case "different worker":
				a.Task.LeaseOwner = "another-worker"
			case "different space":
				a.Scope.SpaceID = "foreign-space"
				op.Scope = a.Scope
			case "expired lease":
				current := task
				expired := h.deps.Clock().Add(-time.Second)
				current.LeaseUntil = &expired
				var raw []byte
				raw, err = json.Marshal(current)
				if err == nil {
					_, err = h.deps.DB.Exec(`UPDATE execution_tasks SET lease_until=?,task_json=? WHERE run_id=? AND id=?`, runtimeTimeString(expired), string(raw), a.Run.ID, a.Task.ID)
				}
			case "run cancelled":
				current, e := h.projects.GetRun(ctx, a.Scope.TenantID, a.Scope.ProjectID, a.Run.ID)
				err = e
				if err == nil {
					current.Status = "cancelled"
					var raw []byte
					raw, err = json.Marshal(current)
					if err == nil {
						_, err = h.deps.DB.Exec(`UPDATE execution_runs SET status='cancelled',run_json=? WHERE id=?`, string(raw), a.Run.ID)
					}
				}
			case "operation completed":
				ref := projectexec.FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
				err = h.projects.CompleteOperation(ctx, ref, op.ID, mission.ToolResult{Content: json.RawMessage(`{}`)})
			case "tenant draining":
				_, err = h.deps.DB.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES(?,1,'now')`, a.Scope.TenantID)
			}
			if err != nil {
				t.Fatal(err)
			}
			// There is intentionally no runner bridge in this fixture. A denied
			// request must fail at SQL admission rather than reach the RPC sentinel.
			result, err := h.projectTaskContext(ctx, a, op)
			if !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrConflict) && !errors.Is(err, projectexec.ErrNotFound) && !errors.Is(err, projectexec.ErrConflict) && !errors.Is(err, projectexec.ErrTenantDraining) {
				t.Fatalf("invalid context reached runner layer: result=%s err=%v", result.Content, err)
			}
			if len(result.Content) != 0 {
				t.Fatal("denied admission returned context content")
			}
		})
	}
}
