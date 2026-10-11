// SPDX-License-Identifier: AGPL-3.0-or-later
package projectcampaign

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func (s *Store) BeginProvision(ctx context.Context, tenant, cid, author string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "draft" && c.Status != "provisioning" {
			return ErrConflict
		}
		c.Status = "provisioning"
		return s.audit(ctx, tx, *c, author, "provision.requested", "", "", nil)
	})
}

func (s *Store) FinishProvision(ctx context.Context, tenant, cid, author string, details any) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "provisioning" {
			return ErrConflict
		}
		c.Status = "draft"
		return s.audit(ctx, tx, *c, author, "provision.observed", "", "", details)
	})
}

func (s *Store) Provisioned(ctx context.Context, tenant, cid, vid string, p mission.Project) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.Project.ID != p.ID || v.DefinitionHash != campaign.ProjectHash(p) {
			return ErrConflict
		}
		if v.State != "prepared" && v.State != "provisioned" {
			return ErrConflict
		}
		v.Project = p
		v.State = "provisioned"
		return s.audit(ctx, tx, *c, "", "project.provisioned", vid, "", map[string]any{"projectId": p.ID})
	})
}

func (s *Store) Capture(ctx context.Context, tenant, cid, author, comment string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "draft" || c.CaptureState != "unfrozen" && c.CaptureState != "failed" {
			return ErrConflict
		}
		for _, v := range c.Definition.Variants {
			if v.State != "provisioned" {
				return ErrConflict
			}
		}
		op, err := id()
		if err != nil {
			return err
		}
		c.CaptureOperationID = "capture_" + op
		c.CaptureState = "capturing"
		c.CaptureError = ""
		return s.audit(ctx, tx, *c, author, "source.capture.requested", "", comment, map[string]any{"operationId": c.CaptureOperationID})
	})
}

func (s *Store) CaptureResult(ctx context.Context, tenant, cid, operation, snapshot, state, message, author, comment string) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.CaptureOperationID != operation || c.CaptureState != "capturing" && c.CaptureState != "unknown" {
			return ErrConflict
		}
		if state != "ready" && state != "unknown" && state != "failed" {
			return ErrConflict
		}
		if state == "ready" && snapshot == "" {
			return ErrConflict
		}
		c.CaptureState = state
		c.CaptureError = message
		if state == "ready" {
			c.BaseSnapshot = snapshot
		}
		return s.audit(ctx, tx, *c, author, "source.capture."+state, "", comment, map[string]any{"operationId": operation, "snapshotId": snapshot, "error": message})
	})
}

func (s *Store) Copy(ctx context.Context, tenant, cid, vid, author string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.CaptureState != "ready" || c.Status == "cancelled" || c.Status == "controlling" {
			return ErrConflict
		}
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.State != "provisioned" && v.State != "copy_failed" {
			return ErrConflict
		}
		op, err := id()
		if err != nil {
			return err
		}
		v.CopyOperationID = "copy_" + op
		v.State = "copying"
		v.Error = ""
		return s.audit(ctx, tx, *c, author, "snapshot.copy.requested", vid, "", map[string]any{"operationId": v.CopyOperationID, "snapshotId": c.BaseSnapshot})
	})
}

func (s *Store) CopyResult(ctx context.Context, tenant, cid, vid, operation, snapshot, state, message, author, comment string) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.CopyOperationID != operation || v.State != "copying" && v.State != "copy_unknown" {
			return ErrConflict
		}
		if state != "ready" && state != "copy_unknown" && state != "copy_failed" {
			return ErrConflict
		}
		if state == "ready" && snapshot != c.BaseSnapshot {
			return ErrConflict
		}
		v.State = state
		v.Error = message
		return s.audit(ctx, tx, *c, author, "snapshot.copy."+state, vid, comment, map[string]any{"operationId": operation, "snapshotId": snapshot, "error": message})
	})
}

// Start reserves the run identity and concurrency slot before CreateRunOnce.
// Failed and unresolved attempts keep their original fixed budget grant.
func (s *Store) Start(ctx context.Context, tenant, cid, vid, author, comment string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.CaptureState != "ready" || c.Status != "draft" && c.Status != "active" {
			return ErrConflict
		}
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.State != "ready" || v.RunID != "" {
			return ErrConflict
		}
		var active int
		err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM project_campaign_variants v LEFT JOIN execution_runs r ON r.tenant_id=v.tenant_id AND r.project_id=v.project_id AND r.id=v.run_id WHERE v.tenant_id=? AND v.campaign_id=? AND (v.state IN ('starting','start_unknown') OR (v.state='started' AND COALESCE(r.status,'unknown') NOT IN ('completed','failed','cancelled')))`), tenant, cid).Scan(&active)
		if err != nil {
			return err
		}
		if active >= c.Definition.Budget.MaxConcurrent {
			return ErrActiveLimit
		}
		var raw string
		if err = tx.QueryRowContext(ctx, s.rebind(`SELECT project_json FROM execution_projects WHERE tenant_id=? AND id=?`), tenant, v.Project.ID).Scan(&raw); err != nil {
			return err
		}
		var current mission.Project
		if err = decode(raw, &current); err != nil {
			return err
		}
		if campaign.ProjectHash(current) != v.DefinitionHash || current.Revision != v.Project.Revision {
			return ErrConflict
		}
		var runs int
		if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_runs WHERE tenant_id=? AND project_id=?`), tenant, v.Project.ID).Scan(&runs); err != nil {
			return err
		}
		if runs != 0 {
			return ErrConflict
		}
		rid, err := id()
		if err != nil {
			return err
		}
		v.RunID = rid
		v.State = "starting"
		c.Status = "active"
		return s.audit(ctx, tx, *c, author, "run.start.requested", vid, comment, map[string]any{"runId": rid, "baseSnapshot": c.BaseSnapshot, "budget": v.Project.Config.Budget})
	})
}

func (s *Store) StartResult(ctx context.Context, tenant, cid, vid, rid, state, message, author, comment string) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.RunID != rid || v.State != "starting" && v.State != "start_unknown" {
			return ErrConflict
		}
		if state != "started" && state != "start_unknown" && state != "start_failed" {
			return ErrConflict
		}
		v.State = state
		v.Error = message
		return s.audit(ctx, tx, *c, author, "run.start."+state, vid, comment, map[string]any{"runId": rid, "error": message})
	})
}

func (s *Store) RetryStart(ctx context.Context, tenant, cid, vid, author, comment string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "active" {
			return ErrConflict
		}
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if v.State != "start_unknown" || v.RunID == "" {
			return ErrConflict
		}
		v.State = "starting"
		return s.audit(ctx, tx, *c, author, "run.start.retry.requested", vid, comment, map[string]any{"runId": v.RunID})
	})
}

func (s *Store) BeginControl(ctx context.Context, tenant, cid, author, comment, action string, expected int64) (campaign.Campaign, error) {
	if expected < 1 {
		return campaign.Campaign{}, ErrConflict
	}
	return s.mutate(ctx, tenant, cid, expected, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status == "controlling" || c.Status == "cancelled" || c.Status == "provisioning" {
			return ErrConflict
		}
		if action != "pause" && action != "resume" && action != "cancel" {
			return ErrConflict
		}
		c.Status = "controlling"
		c.ControlAction = action
		return s.audit(ctx, tx, *c, author, "control.requested", "", comment, map[string]any{"action": action})
	})
}

func (s *Store) FinishControl(ctx context.Context, tenant, cid, author, comment string, results any) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "controlling" {
			return ErrConflict
		}
		switch c.ControlAction {
		case "pause":
			c.Status = "paused"
		case "resume":
			c.Status = "active"
		case "cancel":
			c.Status = "cancelled"
		default:
			return ErrConflict
		}
		raw, err := json.Marshal(results)
		if err != nil {
			return err
		}
		var outcomes []struct {
			Error string `json:"error"`
		}
		if err = json.Unmarshal(raw, &outcomes); err != nil {
			return err
		}
		for _, outcome := range outcomes {
			if outcome.Error != "" {
				c.Status = "control_partial"
				break
			}
		}
		return s.audit(ctx, tx, *c, author, "control.observed", "", comment, results)
	})
}

// CancelUnstarted settles a reserved identity only after BeginControl acquired
// the campaign row lock. CreateRunOnce takes that same lock before inserting a
// managed run and refuses new insertion while controlling. A missing run is
// therefore a definite non-effect, even if an older start caller is still in
// flight. The reservation remains in the journal and can never be reused.
func (s *Store) CancelUnstarted(ctx context.Context, tenant, cid, vid, rid, author, comment string) (campaign.Campaign, error) {
	return s.mutate(ctx, tenant, cid, 0, func(tx *sql.Tx, c *campaign.Campaign) error {
		if c.Status != "controlling" || c.ControlAction != "cancel" {
			return ErrConflict
		}
		v, err := variant(c, vid)
		if err != nil {
			return err
		}
		if rid == "" || v.RunID != rid || v.State != "starting" && v.State != "start_unknown" && v.State != "start_failed" {
			return ErrConflict
		}
		var count int
		if err = tx.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM execution_runs WHERE tenant_id=? AND project_id=? AND id=?`), tenant, v.Project.ID, rid).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return ErrConflict
		}
		v.State = "start_failed"
		v.Error = "Cancelled before the reserved run was created"
		return s.audit(ctx, tx, *c, author, "start.cancelled_without_run", vid, comment, map[string]any{"runId": rid})
	})
}

func (s *Store) SourceReferenced(ctx context.Context, tenant, pid string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.rebind(`SELECT COUNT(*) FROM project_campaigns WHERE tenant_id=? AND source_project_id=?`), tenant, pid).Scan(&n)
	return n != 0, err
}
