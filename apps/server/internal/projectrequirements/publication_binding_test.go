// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrequirements

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func TestFirstRequirementsBindingPrecedesPublicationIntent(t *testing.T) {
	for _, tc := range []struct {
		kind, status string
		blocked      bool
	}{
		{"merge", "applying", true},
		{"merge", "unknown", true},
		{"merge", "applied", true},
		{"merge", "approved", false},
		{"merge", "abandoned", false},
		{"delivery", "preparing", true},
		{"delivery", "unknown", true},
		{"delivery", "ready", true},
		{"delivery", "revoked", true},
		{"import", "ready", false},
		{"unrelated-delivery", "ready", false},
	} {
		t.Run(tc.kind+"/"+tc.status, func(t *testing.T) {
			s, exec, p, scope := setup(t)
			ctx := context.Background()
			baseline := approve(t, s, p, scope)
			run, err := exec.CreateRun(ctx, p.TenantID, p.ID, "base")
			if err != nil {
				t.Fatal(err)
			}
			if tc.kind == "merge" {
				_, err = s.db.Exec(`INSERT INTO execution_merge_previews(id,tenant_id,project_id,run_id,revision,status,preview_json,created_at,updated_at) VALUES('preview',?,?,?,?,?,'{}','now','now')`, p.TenantID, p.ID, run.ID, 1, tc.status)
			} else {
				kind, deliveryRun := tc.kind, run.ID
				if kind == "unrelated-delivery" {
					kind, deliveryRun = "delivery", "another-run"
				}
				// The unrelated nested runId must not count as the manifest's run.
				record, e := json.Marshal(map[string]any{"manifest": map[string]any{"runId": deliveryRun}, "nested": map[string]any{"runId": run.ID}})
				if e != nil {
					t.Fatal(e)
				}
				_, err = s.db.Exec(`INSERT INTO execution_deliveries(id,tenant_id,project_id,kind,name,version,revision,status,record_json,created_at,updated_at) VALUES('outbound',?,?,?,'artifact','1',1,?,?, 'now','now')`, p.TenantID, p.ID, kind, tc.status, string(record))
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.Bind(ctx, scope, baseline.ID, run.ID, baseline.Revision, "member")
			if tc.blocked {
				if !errors.Is(err, ErrInvalid) {
					t.Fatalf("post-intent binding accepted: %v", err)
				}
				if _, found, e := s.Binding(ctx, scope, run.ID); e != nil || found {
					t.Fatalf("failed bind left historical criteria: found=%v err=%v", found, e)
				}
				var events int
				if e := s.db.QueryRow(`SELECT COUNT(*) FROM execution_events WHERE tenant_id=? AND project_id=? AND run_id=? AND event_json LIKE '%requirements.bound%'`, p.TenantID, p.ID, run.ID).Scan(&events); e != nil || events != 0 {
					t.Fatalf("failed bind left audit: events=%d err=%v", events, e)
				}
			} else if err != nil {
				t.Fatalf("prepublication or unrelated artifact blocked: %v", err)
			}
		})
	}
}

func TestExistingRequirementsBindingRemainsIdempotentAfterPublication(t *testing.T) {
	s, exec, p, scope := setup(t)
	ctx := context.Background()
	baseline := approve(t, s, p, scope)
	run, err := exec.CreateRun(ctx, p.TenantID, p.ID, "base")
	if err != nil {
		t.Fatal(err)
	}
	original, err := s.Bind(ctx, scope, baseline.ID, run.ID, baseline.Revision, "member")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO execution_merge_previews(id,tenant_id,project_id,run_id,revision,status,preview_json,created_at,updated_at) VALUES('published',?,?,?,?, 'applied','{}','now','now')`, p.TenantID, p.ID, run.ID, 1); err != nil {
		t.Fatal(err)
	}
	current, err := s.Bind(ctx, mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}, baseline.ID, run.ID, baseline.Revision, "another-member")
	if err != nil || current.BaselineHash != original.BaselineHash || current.BoundBy != original.BoundBy || !current.BoundAt.Equal(original.BoundAt) {
		t.Fatalf("idempotent historical binding changed: original=%+v current=%+v err=%v", original, current, err)
	}
}
