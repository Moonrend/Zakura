// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
	_ "github.com/lib/pq"
)

func TestProjectIndependentSignoffPostgresMembershipRevocationSerializesWithPublication(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; actual PostgreSQL signoff publication row locks were not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err = admin.PingContext(ctx); err != nil {
		t.Fatal("connect PostgreSQL signoff row-lock test:", err)
	}
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	schema := "zakura_signoff_gate_" + hex.EncodeToString(nonce[:])
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Error("drop signoff row-lock schema:", err)
		}
	}()
	isolated := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, e := url.Parse(dsn)
		if e != nil {
			t.Fatal(e)
		}
		q := u.Query()
		q.Set("search_path", schema)
		q.Set("application_name", schema)
		u.RawQuery = q.Encode()
		isolated = u.String()
	} else {
		isolated += " search_path='" + schema + "' application_name='" + schema + "'"
	}
	db, err := sql.Open("postgres", isolated)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)
	if err = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); err != nil {
		t.Fatal(err)
	}
	var ids atomic.Int64
	d := &appdeps.Dependencies{DB: db, Dialect: "postgres", Rebind: appdeps.PostgresRebind, Clock: func() time.Time { return time.Now().UTC() }, NewID: func() string { return fmt.Sprintf("signoff-gate-%d", ids.Add(1)) }}
	h := &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(db, d.Dialect, d.Rebind)}
	h.initializeProjectSignoffs()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, e := db.ExecContext(ctx, d.Rebind(query), args...); e != nil {
			t.Fatal(e)
		}
	}
	now := runtimeTimeString(d.Clock())
	exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('tenant','tenant','Signoff gate',?,?)`, now, now)
	exec(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('space','tenant','Signoff gate','space',?,?)`, now, now)
	for _, id := range []string{"owner", "a", "b"} {
		exec(`INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)`, id, id+"@signoff.example", id, now, now)
		role := "member"
		if id == "owner" {
			role = "owner"
		}
		exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,created_at,updated_at) VALUES(?,'tenant',?,?,?,?)`, "membership-"+id, id, role, now, now)
	}
	p, err := h.projects.CreateProject(ctx, mission.Project{TenantID: "tenant", SpaceID: "space", CreatedBy: "owner", Name: "Signoff lock", Goal: "Serialize revocation against publication", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "work", Title: "Work", Prompt: "Work", AgentID: "fixture-agent", MaxAttempts: 1, Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "work.txt", Required: true}}}}}, Config: mission.Config{MaxTasks: 10}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := h.projects.CreateRun(ctx, p.TenantID, p.ID, "base")
	if err != nil {
		t.Fatal(err)
	}
	// This test isolates the actual publication membership gate. Artifact proof
	// validation is covered by the independent HTTP test; no runner is invoked.
	preview := projectMergePreview{ID: "preview", ProjectID: p.ID, RunID: run.ID, RunRevision: run.Revision, Status: "ready", PlanID: "plan", Plan: workspace.MergePlan{ID: "plan", Result: workspace.Snapshot{ID: "final"}}, ExpectedBase: "base", TaskSnapshots: map[string]string{}}
	if err = h.saveMerge(ctx, p, preview); err != nil {
		t.Fatal(err)
	}
	preview, err = h.loadMerge(ctx, p.TenantID, p.ID, run.ID, preview.ID)
	if err != nil {
		t.Fatal(err)
	}
	preview, err = h.mutateMerge(ctx, p, run.ID, preview.ID, preview.Revision, "owner", "fixture.quorum", "Prepare actual policy and persisted votes", func(tx *sql.Tx, current *projectMergePreview) error {
		if _, e := h.projectSignoffs.SetPolicyTx(ctx, tx, p, 0, signoff.Rules{MinApprovals: 2, EligibleRoles: []string{"member"}}, "owner"); e != nil {
			return e
		}
		b, e := projectSignoffBinding(current)
		if e != nil {
			return e
		}
		var summary signoff.Summary
		for _, user := range []string{"a", "b"} {
			summary, e = h.projectSignoffs.RecordTx(ctx, tx, p, b, current.Revision, user, "member", "approved", "Independent row-lock fixture vote")
			if e != nil {
				return e
			}
		}
		return setProjectSignoffResult(h, current, summary, "b", "Quorum ready")
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []struct {
		name, query string
	}{
		{"membership deletion", `DELETE FROM tenant_memberships WHERE tenant_id='tenant' AND user_id='a'`},
		{"role change", `UPDATE tenant_memberships SET role='admin' WHERE tenant_id='tenant' AND user_id='a'`},
		{"user suspension", `UPDATE users SET status='suspended',suspended_at='now' WHERE id='a'`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			publication, e := db.BeginTx(ctx, nil)
			if e != nil {
				t.Fatal(e)
			}
			defer publication.Rollback()
			if e = h.lockProjectMutation(ctx, publication, p); e != nil {
				t.Fatal(e)
			}
			if e = h.requireProjectSignoffTx(ctx, publication, p, &preview); e != nil {
				t.Fatal("valid quorum failed:", e)
			}
			finished := make(chan error, 1)
			go func() { _, e := db.ExecContext(ctx, mutation.query); finished <- e }()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			waiting := false
			for !waiting {
				select {
				case e := <-finished:
					t.Fatalf("revocation committed before publication gate transaction: %v", e)
				case <-ctx.Done():
					t.Fatal("revocation never reached publication member lock:", ctx.Err())
				case <-ticker.C:
					if e = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query=$2)`, schema, mutation.query).Scan(&waiting); e != nil {
						t.Fatal(e)
					}
				}
			}
			if e = publication.Commit(); e != nil {
				t.Fatal(e)
			}
			select {
			case e = <-finished:
				if e != nil {
					t.Fatal("revocation did not commit after gate:", e)
				}
			case <-ctx.Done():
				t.Fatal("revocation remained blocked after commit:", ctx.Err())
			}
			blocked, e := db.BeginTx(ctx, nil)
			if e != nil {
				t.Fatal(e)
			}
			defer blocked.Rollback()
			if e = h.lockProjectMutation(ctx, blocked, p); e != nil {
				t.Fatal(e)
			}
			if e = h.requireProjectSignoffTx(ctx, blocked, p, &preview); e == nil {
				t.Fatal("publication reused approval after committed revocation")
			}
			if e = blocked.Rollback(); e != nil {
				t.Fatal(e)
			}
			// Restore authority for the next independent revocation case.
			exec(`UPDATE users SET status='active',suspended_at=NULL WHERE id='a'`)
			exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('membership-a','tenant','a','member','active',?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='member',status='active'`, now, now)
		})
	}
}
