// SPDX-License-Identifier: AGPL-3.0-or-later
package projectknowledge

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"

	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func decodeNote(raw json.RawMessage) (knowledge.Draft, error) {
	var draft struct {
		Title   string             `json:"title"`
		Body    string             `json:"body"`
		Format  string             `json:"format"`
		Tags    []string           `json:"tags"`
		Sources []knowledge.Source `json:"sources"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&draft); err != nil {
		return knowledge.Draft{}, invalid("invalid project_note arguments")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return knowledge.Draft{}, invalid("project_note arguments must be a single JSON object")
	}
	return knowledge.Draft{Kind: "note", Title: draft.Title, Body: draft.Body, Format: draft.Format, Tags: draft.Tags, Sources: draft.Sources}, nil
}
func (s *Store) receipt(ctx context.Context, q reader, scope mission.Scope, op mission.Operation) (mission.Inspection, error) {
	var hash, run, task, raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT arguments_hash,run_id,task_id,result_json FROM execution_knowledge_receipts WHERE tenant_id=? AND project_id=? AND operation_id=?`), scope.TenantID, scope.ProjectID, op.ID).Scan(&hash, &run, &task, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return mission.Inspection{}, nil
	}
	if err != nil {
		return mission.Inspection{}, err
	}
	if hash != op.ArgumentsHash || run != op.RunID || task != op.TaskID {
		return mission.Inspection{}, ErrConflict
	}
	return mission.Inspection{Known: true, Result: mission.ToolResult{Content: json.RawMessage(raw)}}, nil
}
func (s *Store) InspectNote(ctx context.Context, scope mission.Scope, op mission.Operation) (mission.Inspection, error) {
	if err := s.requireScope(ctx, s.db, scope); err != nil {
		return mission.Inspection{}, err
	}
	return s.receipt(ctx, s.db, scope, op)
}
func (s *Store) NoteOperation(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
	var out mission.ToolResult
	if op.Call.Name != "project_note" || op.Call.Effect != "workspace_write" || op.Scope != a.Scope || op.RunID != a.Run.ID || op.TaskID != a.Task.ID || op.ID == "" || op.ArgumentsHash == "" {
		return out, ErrInvalid
	}
	err := s.tx(ctx, a.Scope, func(tx *sql.Tx) error {
		receipt, e := s.receipt(ctx, tx, a.Scope, op)
		if e != nil {
			return e
		}
		if receipt.Known {
			out = receipt.Result
			return nil
		}
		// The operation must already have been durably admitted by the engine,
		// and the worker must still own this task incarnation. Model tool input
		// cannot forge a direct knowledge write or bypass cancellation.
		var operationRaw, taskRaw, runStatus string
		e = tx.QueryRowContext(ctx, s.rebind(`SELECT o.operation_json,t.task_json,r.status FROM execution_operations o JOIN execution_tasks t ON t.tenant_id=o.tenant_id AND t.project_id=o.project_id AND t.run_id=o.run_id AND t.id=o.task_id JOIN execution_runs r ON r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.id=o.run_id WHERE o.tenant_id=? AND o.project_id=? AND o.run_id=? AND o.task_id=? AND o.id=?`), a.Scope.TenantID, a.Scope.ProjectID, op.RunID, op.TaskID, op.ID).Scan(&operationRaw, &taskRaw, &runStatus)
		if e != nil {
			return notFound(e)
		}
		var stored mission.Operation
		var task mission.Task
		if e = json.Unmarshal([]byte(operationRaw), &stored); e != nil {
			return e
		}
		if e = json.Unmarshal([]byte(taskRaw), &task); e != nil {
			return e
		}
		if stored.ArgumentsHash != op.ArgumentsHash || stored.Call.Name != op.Call.Name || stored.Status != "running" || runStatus != "running" || task.Status != "running" || task.Fence != a.Task.Fence || task.LeaseOwner != a.Task.LeaseOwner || task.LeaseUntil == nil || !task.LeaseUntil.After(s.now()) {
			return ErrConflict
		}
		draft, e := decodeNote(stored.Call.Arguments)
		if e != nil {
			return e
		}
		draft.RunID = op.RunID
		draft.TaskID = op.TaskID
		entry, e := s.create(ctx, tx, a.Scope, draft, "agent:"+task.Spec.AgentID)
		if e != nil {
			return e
		}
		raw, e := json.Marshal(map[string]any{"entry": entry, "untrustedReference": true})
		if e != nil {
			return e
		}
		out = mission.ToolResult{Content: raw}
		_, e = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_knowledge_receipts(tenant_id,project_id,operation_id,arguments_hash,run_id,task_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)`), a.Scope.TenantID, a.Scope.ProjectID, op.ID, op.ArgumentsHash, op.RunID, op.TaskID, string(raw), stamp(s.now()))
		return e
	})
	return out, err
}
