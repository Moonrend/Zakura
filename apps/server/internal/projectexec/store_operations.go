package projectexec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func argumentsHash(call mission.ToolCall) (string, error) {
	if call.ID == "" || call.Name == "" || (call.Effect != "read" && call.Effect != "workspace_write" && call.Effect != "external_write") {
		return "", ErrInvalidState
	}
	var args any
	if len(call.Arguments) == 0 {
		args = map[string]any{}
	} else {
		decoder := json.NewDecoder(bytes.NewReader(call.Arguments))
		decoder.UseNumber()
		if e := decoder.Decode(&args); e != nil {
			return "", fmt.Errorf("%w: invalid tool arguments: %v", ErrInvalidState, e)
		}
		var extra any
		if e := decoder.Decode(&extra); e != io.EOF {
			return "", ErrInvalidState
		}
	}
	raw, e := json.Marshal(struct {
		Name      string `json:"name"`
		Effect    string `json:"effect"`
		Arguments any    `json:"arguments"`
	}{call.Name, call.Effect, args})
	if e != nil {
		return "", e
	}
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), nil
}
func (s *Store) operation(ctx context.Context, q sqlReader, scope mission.Scope, rid, oid string) (mission.Operation, error) {
	var raw string
	e := q.QueryRowContext(ctx, s.rebind(`SELECT o.operation_json FROM execution_operations o JOIN execution_projects p ON p.id=o.project_id AND p.tenant_id=o.tenant_id WHERE o.tenant_id=? AND o.project_id=? AND p.space_id=? AND o.run_id=? AND o.id=?`), scope.TenantID, scope.ProjectID, scope.SpaceID, rid, oid).Scan(&raw)
	if e != nil {
		return mission.Operation{}, notFound(e)
	}
	var o mission.Operation
	e = json.Unmarshal([]byte(raw), &o)
	return o, e
}
func (s *Store) GetOperation(ctx context.Context, scope mission.Scope, rid, oid string) (mission.Operation, error) {
	return s.operation(ctx, s.db, scope, rid, oid)
}
func (s *Store) putOperation(ctx context.Context, tx *sql.Tx, o mission.Operation) error {
	raw, e := encode(o)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, s.rebind(`UPDATE execution_operations SET status=?,revision=?,operation_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`), o.Status, o.Revision, raw, stamp(o.UpdatedAt), o.Scope.TenantID, o.Scope.ProjectID, o.RunID, o.ID)
	return e
}
func (s *Store) BeginOperation(ctx context.Context, ref FenceRequest, checkpointID string, call mission.ToolCall) (mission.Operation, bool, error) {
	var out mission.Operation
	created := false
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		hash, e := argumentsHash(call)
		if e != nil {
			return e
		}
		var raw string
		e = tx.QueryRowContext(ctx, s.rebind(`SELECT operation_json FROM execution_operations WHERE tenant_id=? AND project_id=? AND run_id=? AND task_id=? AND checkpoint_id=? AND call_id=?`), ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, checkpointID, call.ID).Scan(&raw)
		if e == nil {
			if e = json.Unmarshal([]byte(raw), &out); e != nil {
				return e
			}
			if out.ArgumentsHash != hash {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		cp, e := s.checkpoint(ctx, tx, ref.Scope, ref.RunID, ref.TaskID)
		if e != nil {
			return e
		}
		if cp.ID != checkpointID || cp.Decision == nil || cp.NextTool >= len(cp.Decision.Tools) {
			return ErrConflict
		}
		expected := cp.Decision.Tools[cp.NextTool]
		expectedHash, e := argumentsHash(expected)
		if e != nil {
			return e
		}
		if expected.ID != call.ID || expectedHash != hash {
			return ErrConflict
		}
		if e = s.reserve(ctx, tx, ref.Scope, &r, p, BudgetReservation{ToolCalls: 1}); e != nil {
			return e
		}
		id, e := newID()
		if e != nil {
			return e
		}
		now := s.now()
		out = mission.Operation{ID: id, Scope: ref.Scope, RunID: ref.RunID, TaskID: ref.TaskID, CheckpointID: checkpointID, Call: call, Status: "prepared", ArgumentsHash: hash, Revision: 1, CreatedAt: now, UpdatedAt: now}
		external := call.Effect != "read" && call.Effect != "workspace_write"
		if external {
			switch p.Config.ExternalEffects {
			case "allow":
			case "review":
				out.Status = "pending_approval"
				t.Status = "waiting_approval"
				t.LeaseOwner = ""
				t.LeaseUntil = nil
				t.Fence++
				t.Revision++
				t.UpdatedAt = now
				if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
					return e
				}
			case "", "deny":
				out.Status = "failed"
				out.Error = "external effects denied by project policy"
			default:
				return ErrInvalidState
			}
		}
		body, e := encode(out)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_operations(id,tenant_id,project_id,run_id,task_id,checkpoint_id,call_id,status,revision,operation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`), id, ref.Scope.TenantID, ref.Scope.ProjectID, ref.RunID, ref.TaskID, checkpointID, call.ID, out.Status, out.Revision, body, stamp(now), stamp(now)); e != nil {
			return e
		}
		created = true
		if e = s.refreshRun(ctx, tx, ref.Scope, r); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "operation.prepared", map[string]any{"operationId": id, "status": out.Status, "effect": call.Effect})
	})
	return out, created, e
}
func (s *Store) StartOperation(ctx context.Context, ref FenceRequest, oid string, revision int64) (mission.Operation, error) {
	var out mission.Operation
	e := s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		_, r, p, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		if p.Config.Budget.MaxWallSeconds > 0 && s.now().Sub(r.CreatedAt) >= time.Duration(p.Config.Budget.MaxWallSeconds)*time.Second {
			return ErrBudgetExceeded
		}
		o, e := s.operation(ctx, tx, ref.Scope, ref.RunID, oid)
		if e != nil {
			return e
		}
		if o.TaskID != ref.TaskID {
			return ErrNotFound
		}
		if o.Revision != revision {
			return ErrConflict
		}
		if o.Status != "prepared" && o.Status != "approved" {
			return ErrInvalidState
		}
		o.Status = "running"
		o.Revision++
		o.UpdatedAt = s.now()
		if e = s.putOperation(ctx, tx, o); e != nil {
			return e
		}
		out = o
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "operation.started", map[string]any{"operationId": oid, "revision": o.Revision})
	})
	return out, e
}
func (s *Store) CompleteOperation(ctx context.Context, ref FenceRequest, oid string, result mission.ToolResult) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		_, _, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		o, e := s.operation(ctx, tx, ref.Scope, ref.RunID, oid)
		if e != nil {
			return e
		}
		if o.TaskID != ref.TaskID {
			return ErrNotFound
		}
		if o.Status != "running" {
			return ErrInvalidState
		}
		if len(result.Content) > 0 && !json.Valid(result.Content) {
			return ErrInvalidState
		}
		o.Status = "completed"
		if result.Error != "" {
			o.Status = "failed"
		}
		o.Result = result.Content
		o.Error = result.Error
		o.Revision++
		o.UpdatedAt = s.now()
		if e = s.putOperation(ctx, tx, o); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "operation.completed", map[string]any{"operationId": oid, "status": o.Status})
	})
}
func (s *Store) MarkOperationUnknown(ctx context.Context, ref FenceRequest, oid, reason string) error {
	return s.tx(ctx, ref.Scope.TenantID, ref.Scope.ProjectID, func(tx *sql.Tx) error {
		t, r, _, e := s.fenced(ctx, tx, ref)
		if e != nil {
			return e
		}
		o, e := s.operation(ctx, tx, ref.Scope, ref.RunID, oid)
		if e != nil {
			return e
		}
		if o.TaskID != ref.TaskID {
			return ErrNotFound
		}
		if o.Status != "running" {
			return ErrInvalidState
		}
		o.Status = "unknown"
		o.Error = reason
		o.Revision++
		o.UpdatedAt = s.now()
		if e = s.putOperation(ctx, tx, o); e != nil {
			return e
		}
		t.Status = "unknown"
		t.Error = reason
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, ref.Scope, t); e != nil {
			return e
		}
		if e = s.refreshRun(ctx, tx, ref.Scope, r); e != nil {
			return e
		}
		return s.event(ctx, tx, ref.Scope, ref.RunID, ref.TaskID, "operation.unknown", map[string]any{"operationId": oid, "reason": reason})
	})
}
func (s *Store) ResolveOperation(ctx context.Context, tenant, pid, rid, oid string, revision int64, res Resolution) (mission.Operation, error) {
	var out mission.Operation
	if res.AuthorID == "" || res.Comment == "" {
		return out, fmt.Errorf("%w: human author and explanation required", ErrInvalidState)
	}
	if len(res.Result) > 0 && !json.Valid(res.Result) {
		return out, ErrInvalidState
	}
	e := s.tx(ctx, tenant, pid, func(tx *sql.Tx) error {
		p, e := s.project(ctx, tx, tenant, pid)
		if e != nil {
			return e
		}
		scope := scopeOf(p)
		r, e := s.run(ctx, tx, tenant, pid, rid)
		if e != nil {
			return e
		}
		if r.Status == "completed" {
			return ErrInvalidState
		}
		draining, e := s.tenantDraining(ctx, tx, tenant)
		if e != nil {
			return e
		}
		stopped := draining || r.Status == "cancelled" || (r.Status == "failed" && (r.Error == "model exceeded reserved token allowance" || r.Error == "wall-time budget exhausted"))
		o, e := s.operation(ctx, tx, scope, rid, oid)
		if e != nil {
			return e
		}
		if o.Revision != revision {
			return ErrConflict
		}
		t, e := s.task(ctx, tx, scope, rid, o.TaskID)
		if e != nil {
			return e
		}
		switch o.Status {
		case "pending_approval":
			switch res.Decision {
			case "approved":
				o.Status = "approved"
			case "denied":
				o.Status = "failed"
				o.Error = res.Error
				if o.Error == "" {
					o.Error = "external effect rejected by reviewer"
				}
			default:
				return ErrInvalidState
			}
		case "unknown":
			switch res.Decision {
			case "completed":
				o.Status = "completed"
				o.Result = res.Result
				o.Error = res.Error
				if res.Error != "" {
					o.Status = "failed"
				}
			case "failed":
				o.Status = "failed"
				o.Result = res.Result
				o.Error = res.Error
				if o.Error == "" {
					o.Error = "operator confirmed operation failure"
				}
			case "not_performed":
				o.Status = "prepared"
				o.Result = nil
				o.Error = ""
			default:
				return ErrInvalidState
			}
		default:
			return ErrInvalidState
		}
		o.Revision++
		o.UpdatedAt = s.now()
		if e = s.putOperation(ctx, tx, o); e != nil {
			return e
		}
		if t.Status != "unknown" && t.Status != "waiting_approval" && !(stopped && (t.Status == "cancelled" || t.Status == "failed")) {
			return ErrInvalidState
		}
		if stopped {
			if res.Decision == "not_performed" {
				o.Status = "failed"
				o.Error = "run stopped after operator confirmed no effect"
				if e = s.putOperation(ctx, tx, o); e != nil {
					return e
				}
			}
		} else {
			t.Status = "pending"
		}
		t.Error = ""
		t.LeaseOwner = ""
		t.LeaseUntil = nil
		t.Fence++
		t.Revision++
		t.UpdatedAt = s.now()
		if e = s.putTask(ctx, tx, scope, t); e != nil {
			return e
		}
		if !stopped {
			if e = s.refreshRun(ctx, tx, scope, r); e != nil {
				return e
			}
		}
		out = o
		return s.event(ctx, tx, scope, rid, t.ID, "operation.resolved", map[string]any{"operationId": oid, "decision": res.Decision, "authorId": res.AuthorID, "comment": res.Comment})
	})
	return out, e
}
