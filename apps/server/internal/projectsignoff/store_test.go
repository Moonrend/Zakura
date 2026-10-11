// SPDX-License-Identifier: AGPL-3.0-or-later
package projectsignoff

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
	_ "github.com/mattn/go-sqlite3"
)

func signoffStoreFixture(t *testing.T) (*Store, mission.Project, signoff.Binding) {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "signoff.db")+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=10000")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id))`, `CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,status TEXT NOT NULL DEFAULT 'active',suspended_at TEXT)`, `CREATE TABLE tenant_memberships(tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',PRIMARY KEY(tenant_id,user_id))`, `INSERT INTO tenants VALUES('tenant'),('foreign')`, `INSERT INTO spaces VALUES('space','tenant')`, `INSERT INTO users(id) VALUES('owner'),('alice'),('bob'),('carol'),('outsider')`, `INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES('tenant','owner','owner'),('tenant','alice','member'),('tenant','bob','member'),('tenant','carol','admin'),('foreign','outsider','owner')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"0006_project_execution.sql", "0007_project_merge_reviews.sql", "0010_project_portfolio.sql", "0015_project_signoffs.sql"} {
		raw, e := os.ReadFile("../platform/migrations/sql/" + name)
		if e != nil {
			t.Fatal(e)
		}
		for _, q := range strings.Split(string(raw), "-- statement-breakpoint") {
			if _, e = db.Exec(q); e != nil {
				t.Fatal(name, e)
			}
		}
	}
	exec := projectexec.NewStore(db, "sqlite", nil)
	p, err := exec.CreateProject(context.Background(), mission.Project{ID: "project", TenantID: "tenant", SpaceID: "space", CreatedBy: "owner", Name: "Independent review", Goal: "Gate actual immutable artifact", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "feature", Title: "Feature", Prompt: "Implement feature", AgentID: "agent", Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "feature.go", Required: true}}}}}, Config: mission.Config{MaxTasks: 10}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := exec.CreateRun(context.Background(), p.TenantID, p.ID, "base")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO execution_merge_previews(id,tenant_id,project_id,run_id,revision,status,preview_json,created_at,updated_at) VALUES('preview',?,?,?,1,'ready','{}','now','now')`, p.TenantID, p.ID, run.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	return NewStore(db, "sqlite", nil, func() time.Time { return now }), p, signoff.Binding{PreviewID: "preview", RunID: run.ID, SnapshotID: "snapshot", EvidenceHash: "immutable-proof"}
}
func signoffTx(t *testing.T, s *Store, p mission.Project, fn func(*sql.Tx) error) error {
	t.Helper()
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE execution_projects SET event_sequence=event_sequence WHERE tenant_id=? AND id=?`, p.TenantID, p.ID); err != nil {
		t.Fatal(err)
	}
	if err = projectexec.NewStore(s.db, "sqlite", nil).RequireTenantActive(ctx, tx, p.TenantID); err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func TestStoreIndependentVotesWithdrawAndRollbackCannotForgeQuorum(t *testing.T) {
	s, p, b := signoffStoreFixture(t)
	ctx := context.Background()
	rules := signoff.Rules{MinApprovals: 2, EligibleRoles: []string{"member", "admin"}, EligibleReviewerIDs: []string{"alice", "bob", "carol"}, DisallowProjectCreator: true, ExpirySeconds: 60}
	if err := signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.SetPolicyTx(ctx, tx, p, 0, rules, "alice"); return e }); !errors.Is(err, ErrInvalid) {
		t.Fatal("member configured policy", err)
	}
	if err := signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.SetPolicyTx(ctx, tx, p, 0, rules, "owner"); return e }); err != nil {
		t.Fatal(err)
	}
	var summary signoff.Summary
	vote := func(user, role string) error {
		return signoffTx(t, s, p, func(tx *sql.Tx) error {
			var err error
			summary, err = s.RecordTx(ctx, tx, p, b, 7, user, role, "approved", "Checked exact bytes")
			return err
		})
	}
	if err := vote("alice", "member"); err != nil || summary.Quorum || summary.Approvals != 1 {
		t.Fatal(summary, err)
	}
	if err := vote("alice", "member"); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate voter accepted", err)
	}
	if err := vote("outsider", "owner"); !errors.Is(err, ErrInvalid) {
		t.Fatal("foreign tenant vote accepted", err)
	}
	if err := vote("bob", "admin"); !errors.Is(err, ErrConflict) {
		t.Fatal("stale role accepted", err)
	}
	rollback := errors.New("intent failed before commit")
	if err := signoffTx(t, s, p, func(tx *sql.Tx) error {
		if _, e := s.RecordTx(ctx, tx, p, b, 8, "bob", "member", "approved", "Review completed"); e != nil {
			return e
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	summary, err := s.SummaryTx(ctx, s.db, p, b)
	if err != nil || summary.Approvals != 1 || len(summary.Votes) != 1 {
		t.Fatal("rollback left durable approval", summary, err)
	}
	if err = vote("bob", "member"); err != nil || !summary.Quorum || len(summary.Evidence.Participants) != 2 {
		t.Fatal(summary, err)
	}
	id := summary.Votes[0].ID
	if err = signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.WithdrawTx(ctx, tx, p, b, id, "bob"); return e }); !errors.Is(err, ErrNotFound) {
		t.Fatal("other user withdrew", err)
	}
	if err = signoffTx(t, s, p, func(tx *sql.Tx) error { var e error; summary, e = s.WithdrawTx(ctx, tx, p, b, id, "alice"); return e }); err != nil || summary.Quorum || summary.Approvals != 1 || summary.Votes[0].WithdrawalSequence <= summary.Votes[0].Sequence {
		t.Fatal(summary, err)
	}
	if err = vote("alice", "member"); err != nil || !summary.Quorum {
		t.Fatal("withdraw then renewed vote failed", summary, err)
	}
	other := b
	other.SnapshotID = "different"
	changed, err := s.SummaryTx(ctx, s.db, p, other)
	if err != nil || changed.Quorum || changed.Approvals != 0 {
		t.Fatal("different artifact inherited votes", changed, err)
	}
}
func TestStorePolicyCASCurrentEligibilityAndAuditAreAtomic(t *testing.T) {
	s, p, b := signoffStoreFixture(t)
	ctx := context.Background()
	rules := signoff.Rules{MinApprovals: 2, EligibleReviewerIDs: []string{"alice", "bob"}, EligibleRoles: []string{"member"}}
	bad := rules
	bad.EligibleReviewerIDs = []string{"alice", "outsider"}
	if err := signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.SetPolicyTx(ctx, tx, p, 0, bad, "owner"); return e }); !errors.Is(err, ErrInvalid) {
		t.Fatal("foreign eligible ID admitted", err)
	}
	var first signoff.Policy
	if err := signoffTx(t, s, p, func(tx *sql.Tx) error { var e error; first, e = s.SetPolicyTx(ctx, tx, p, 0, rules, "owner"); return e }); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"alice", "bob"} {
		if err := signoffTx(t, s, p, func(tx *sql.Tx) error {
			_, e := s.RecordTx(ctx, tx, p, b, 1, user, "member", "approved", "Approve same immutable artifact")
			return e
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(`UPDATE users SET suspended_at='now' WHERE id='bob'`); err != nil {
		t.Fatal(err)
	}
	summary, err := s.SummaryTx(ctx, s.db, p, b)
	if err != nil || summary.Quorum || summary.Approvals != 1 || summary.CanReachQuorum {
		t.Fatal("suspended member remained eligible", summary, err)
	}
	if _, err = s.db.Exec(`UPDATE users SET suspended_at=NULL WHERE id='bob'`); err != nil {
		t.Fatal(err)
	}
	if err = signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.SetPolicyTx(ctx, tx, p, 0, rules, "owner"); return e }); !errors.Is(err, ErrConflict) {
		t.Fatal("stale policy changed", err)
	}
	if err = signoffTx(t, s, p, func(tx *sql.Tx) error { _, e := s.SetPolicyTx(ctx, tx, p, 1, rules, "owner"); return e }); err != nil {
		t.Fatal(err)
	}
	policy, err := s.GetPolicy(ctx, p)
	if err != nil || policy.Revision != 2 || policy.Hash == first.Hash {
		t.Fatal(policy, err)
	}
	summary, err = s.SummaryTx(ctx, s.db, p, b)
	if err != nil || summary.Quorum || summary.Approvals != 0 || len(summary.Votes) != 2 {
		t.Fatal("previous policy approvals counted", summary, err)
	}
	history, err := s.History(ctx, p)
	if err != nil || len(history) != 2 || history[0].Revision != 2 || history[1].Hash != first.Hash {
		t.Fatal("policy history lost", history, err)
	}
	if _, err = s.db.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('tenant',1,'now')`); err != nil {
		t.Fatal(err)
	}
	if err = signoffTx(t, s, p, func(tx *sql.Tx) error {
		_, e := s.RecordTx(ctx, tx, p, b, 1, "alice", "member", "approved", "Must stop under drain")
		return e
	}); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatal("tenant drain admitted vote", err)
	}
}
