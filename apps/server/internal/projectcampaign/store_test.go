// SPDX-License-Identifier: AGPL-3.0-or-later
package projectcampaign

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/blueprint"
	"github.com/Moonrend/Zakura/packages/projectkit/campaign"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/mattn/go-sqlite3"
)

func setup(t *testing.T) (*Store, *projectexec.Store, campaign.Campaign) {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "campaign.db")+"?_foreign_keys=on&_busy_timeout=10000&_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE)`, `INSERT INTO tenants VALUES('tenant'),('other')`, `INSERT INTO spaces VALUES('space','tenant')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"0006_project_execution.sql", "0012_project_campaigns.sql"} {
		raw, err := os.ReadFile("../platform/migrations/sql/" + name)
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range strings.Split(string(raw), "-- statement-breakpoint") {
			if _, err = db.Exec(q); err != nil {
				t.Fatal(err)
			}
		}
	}
	projects := projectexec.NewStore(db, "sqlite", nil)
	p := mission.Project{TenantID: "tenant", SpaceID: "space", Name: "Source", Goal: "A source project", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "task", Title: "Source task", Prompt: "Validate artifact", AgentID: "agent", Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Path: "artifact.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1}, ExternalEffects: "deny"}}
	p, err = projects.CreateProject(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	b := blueprint.Definition{Name: "Artifact experiment", ProjectName: "Experiment", Goal: "Verify inherited artifact", Config: mission.Config{ExternalEffects: "deny", MaxTasks: 10}, Tasks: []blueprint.Task{{Key: "task", Title: "Verify", Prompt: "Verify the inherited artifact", AgentRole: "worker", Writes: []string{"artifact.txt"}, Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Path: "artifact.txt", Required: true}}}}}
	d, err := campaign.Freeze(campaign.FrozenRequest{Name: "Agent trial", SourceProjectID: p.ID, TemplateID: "template", TemplateVersion: 1, BaselineID: "base", Budget: mission.Budget{MaxTokens: 20000, MaxModelCalls: 20, MaxToolCalls: 20, MaxWallSeconds: 200, MaxConcurrent: 1}, Blueprint: b, Inputs: blueprint.Inputs{SpaceID: "space"}, Variants: []campaign.VariantSpec{{ID: "base", Name: "Base", AgentMapping: map[string]string{"worker": "agent-a"}}, {ID: "candidate", Name: "Candidate", AgentMapping: map[string]string{"worker": "agent-b"}}}})
	if err != nil {
		t.Fatal(err)
	}
	s := NewStore(db, "sqlite", nil)
	c, err := s.Create(context.Background(), "tenant", "space", "", d)
	if err != nil {
		t.Fatal(err)
	}
	return s, projects, c
}

func ready(t *testing.T, s *Store, projects *projectexec.Store, c campaign.Campaign) campaign.Campaign {
	t.Helper()
	ctx := context.Background()
	var err error
	c, err = s.BeginProvision(ctx, c.TenantID, c.ID, "", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range c.Definition.Variants {
		p, err := projects.CreateProject(ctx, v.Project)
		if err != nil {
			t.Fatal(err)
		}
		c, err = s.Provisioned(ctx, c.TenantID, c.ID, v.ID, p)
		if err != nil {
			t.Fatal(err)
		}
	}
	c, err = s.FinishProvision(ctx, c.TenantID, c.ID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.Capture(ctx, c.TenantID, c.ID, "user", "Freeze common source", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.CaptureResult(ctx, c.TenantID, c.ID, c.CaptureOperationID, "common-base", "ready", "", "user", "Receipt known")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range c.Definition.Variants {
		c, err = s.Copy(ctx, c.TenantID, c.ID, v.ID, "user", c.Revision)
		if err != nil {
			t.Fatal(err)
		}
		var op string
		for _, x := range c.Definition.Variants {
			if x.ID == v.ID {
				op = x.CopyOperationID
			}
		}
		c, err = s.CopyResult(ctx, c.TenantID, c.ID, v.ID, op, "common-base", "ready", "", "user", "Copied")
		if err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func TestReservationRecoveryAndConcurrencyCap(t *testing.T) {
	s, projects, c := setup(t)
	c = ready(t, s, projects, c)
	ctx := context.Background()
	if _, err := s.Get(ctx, "other", c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("tenant leak", err)
	}
	started, err := s.Start(ctx, c.TenantID, c.ID, "base", "user", "Begin baseline", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	base := started.Definition.Variants[0]
	if base.RunID == "" || base.State != "starting" {
		t.Fatal("start intent not persisted")
	}
	if _, err = s.Start(ctx, c.TenantID, c.ID, "candidate", "user", "Concurrent start", started.Revision); err == nil {
		t.Fatal("active variant cap exceeded")
	}
	run, err := projects.CreateRunOnce(ctx, c.TenantID, base.Project.ID, c.BaseSnapshot, base.Project.Revision, base.RunID)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate restart after SQL run commit but before the campaign receipt.
	s = NewStore(s.db, "sqlite", nil)
	found, err := projects.GetRun(ctx, c.TenantID, base.Project.ID, base.RunID)
	if err != nil || found.ID != run.ID {
		t.Fatal("lost run identity", err)
	}
	c, err = s.StartResult(ctx, c.TenantID, c.ID, "base", run.ID, "started", "", "user", "Recover exact SQL receipt")
	if err != nil {
		t.Fatal(err)
	}
	run, err = projects.PauseRun(ctx, c.TenantID, base.Project.ID, run.ID, run.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Start(ctx, c.TenantID, c.ID, "candidate", "user", "Paused slot retained", c.Revision); err == nil {
		t.Fatal("paused run released reservation")
	}
	if _, err = projects.CancelRun(ctx, c.TenantID, base.Project.ID, run.ID, run.Revision); err != nil {
		t.Fatal(err)
	}
	c, err = s.Start(ctx, c.TenantID, c.ID, "candidate", "user", "Start after terminal", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Start(ctx, c.TenantID, c.ID, "base", "user", "Cannot start a second baseline", c.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("variant ran twice", err)
	}
}

func TestCancelledCampaignFencesLateSQLStart(t *testing.T) {
	s, projects, c := setup(t)
	c = ready(t, s, projects, c)
	ctx := context.Background()
	c, err := s.Start(ctx, c.TenantID, c.ID, "base", "user", "Start", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	target := c.Definition.Variants[0]
	c, err = s.BeginControl(ctx, c.TenantID, c.ID, "user", "Stop before SQL run commits", "cancel", c.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = projects.CreateRunOnce(ctx, c.TenantID, target.Project.ID, c.BaseSnapshot, target.Project.Revision, target.RunID); !errors.Is(err, projectexec.ErrConflict) {
		t.Fatal("late start crossed cancellation", err)
	}
	c, err = s.FinishControl(ctx, c.TenantID, c.ID, "user", "No committed run", []struct {
		Error string `json:"error"`
	}{{Error: "uncommitted start remains fenced"}})
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != "control_partial" {
		t.Fatal("partial control pretended success")
	}
	if _, err = s.Start(ctx, c.TenantID, c.ID, "candidate", "user", "Must settle control", c.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("partial control permitted new work", err)
	}
}

func TestTenantDrainSourceDeletionAndTenantCascade(t *testing.T) {
	s, projects, c := setup(t)
	c = ready(t, s, projects, c)
	ctx := context.Background()
	var err error
	if _, err = s.db.Exec(`DELETE FROM execution_projects WHERE id=?`, c.Definition.SourceProjectID); err == nil {
		t.Fatal("deleted experiment source and lost budget bindings")
	}
	if _, err = s.db.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('tenant',1,'now')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Start(ctx, c.TenantID, c.ID, "base", "user", "No new work", c.Revision); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatal("drain ignored", err)
	}
	if _, err = s.db.Exec(`DELETE FROM tenants WHERE id='tenant'`); err != nil {
		t.Fatalf("campaign prevented legitimate tenant cascade: %v", err)
	}
	for _, table := range []string{"project_campaigns", "project_campaign_variants", "project_campaign_audit", "execution_projects"} {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("tenant cascade left %s records: %d %v", table, n, err)
		}
	}
}
