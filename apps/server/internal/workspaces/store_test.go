package workspaces

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
)

func testStore(t *testing.T) Store {
	t.Helper()
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "workspace.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.DB.Close() })
	if err = migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	s := Store{DB: conn.DB, Rebind: conn.Rebind}
	for _, q := range []string{
		`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES('tenant','tenant','Tenant','before','before'),('other','other','Other','before','before')`,
		`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('node','tenant','Node','node','server','offline','/existing/storage','before','before')`,
		`INSERT INTO spaces(id,tenant_id,name,slug,runtime_node_id,workspace_kind,workspace_status,workspace_image,created_at,updated_at) VALUES('space','tenant','Space','space','node','container','running','custom:image','before','before')`,
		`INSERT INTO computers(id,tenant_id,space_id,name,provider,role,runtime_node_id,created_at,updated_at) VALUES('legacy:space','tenant','space','Workspace','server','server','node','before','before')`,
		`INSERT INTO workspace_create_operations(space_id,tenant_id,node_id,computer_id,operation_id,name,config_digest,created_at) VALUES('space','tenant','node','legacy:space','op','original-name','original-digest','before')`,
		`INSERT INTO managed_containers(id,tenant_id,space_id,docker_id,name,image,purpose,status,runtime_node_id,created_at,updated_at) VALUES('container','tenant','space','docker-id','original-name','custom:image','workspace','running','node','before','before')`,
		`INSERT INTO computer_workspace_leases(space_id,tenant_id,token,operation,expires_at,intent_json,updated_at) VALUES('space','tenant','original-token','starting',9999999999999,'{"previousStatus":"stopped","uncertain":true}',1)`,
		`INSERT INTO space_projects(id,tenant_id,space_id,slug,name,has_workspace,created_at,updated_at) VALUES('project','tenant','space','project','Project',TRUE,'before','before')`,
	} {
		execTest(t, s, q)
	}
	return s
}

func execTest(t *testing.T, s Store, query string, args ...any) {
	t.Helper()
	if _, err := s.DB.Exec(s.query(query), args...); err != nil {
		t.Fatal(err)
	}
}

func TestAdoptLegacyPreservesEffectsAndRequiresVerification(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	i, err := s.AdoptLegacy(ctx, "tenant", "space", "disk", "instance", now)
	if err != nil {
		t.Fatal(err)
	}
	if i.State != "unknown" || i.Generation != 1 || i.IdentityVersion != 1 || i.DockerID == nil || *i.DockerID != "docker-id" || i.CreateOperationID == nil || *i.CreateOperationID != "op" {
		t.Fatalf("adoption changed identity: %+v", i)
	}
	d, err := s.Disk(ctx, "tenant", "disk")
	if err != nil {
		t.Fatal(err)
	}
	if d.State != "unknown" || d.VerifiedAt != nil || d.Locator != (Locator{Kind: "legacy-bind", RelativePath: "spaces/space/workspace"}) || d.AttachedInstanceID == nil || *d.AttachedInstanceID != i.InstanceID {
		t.Fatalf("unobserved disk became available: %+v", d)
	}
	if _, _, err := s.Resolve(ctx, i.Target); !errors.Is(err, ErrTargetRevoked) {
		t.Fatalf("unverified instance accepted: %v", err)
	}
	var token, intent, name, digest, status, modified string
	if err := s.DB.QueryRow(`SELECT token,intent_json FROM computer_workspace_leases WHERE space_id='space'`).Scan(&token, &intent); err != nil {
		t.Fatal(err)
	}
	if token != "original-token" || intent != `{"previousStatus":"stopped","uncertain":true}` {
		t.Fatal("adoption discarded an unresolved operation")
	}
	if err := s.DB.QueryRow(`SELECT name,config_digest FROM workspace_create_operations WHERE operation_id='op'`).Scan(&name, &digest); err != nil || name != "original-name" || digest != "original-digest" {
		t.Fatalf("creation receipt identity changed: %s %s %v", name, digest, err)
	}
	if err := s.DB.QueryRow(`SELECT workspace_status,updated_at FROM spaces WHERE id='space'`).Scan(&status, &modified); err != nil || status != "running" || modified != "before" {
		t.Fatalf("adoption changed legacy projection: %s %s %v", status, modified, err)
	}
	repeated, err := s.AdoptLegacy(ctx, "tenant", "space", "different-disk", "different-instance", now.Add(time.Hour))
	if err != nil || repeated.Target != i.Target {
		t.Fatalf("adoption not idempotent: %+v %v", repeated, err)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM workspace_disks`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("duplicate disk: %d %v", n, err)
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM workspace_disk_projects WHERE disk_id='disk' AND verified_at IS NULL`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("legacy project materialization lost or falsely verified: %d %v", n, err)
	}
}

func TestAdoptionRejectsForeignAndConflictingMetadata(t *testing.T) {
	for _, scenario := range []string{"foreign", "different-node", "multiple-containers", "retired-space", "invalid-path"} {
		t.Run(scenario, func(t *testing.T) {
			s := testStore(t)
			tenant, space := "tenant", "space"
			switch scenario {
			case "foreign":
				tenant = "other"
			case "different-node":
				execTest(t, s, `INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('other-node','tenant','Other','other-node','server','offline','/other/storage','before','before')`)
				execTest(t, s, `UPDATE managed_containers SET runtime_node_id='other-node'`)
			case "multiple-containers":
				execTest(t, s, `INSERT INTO managed_containers(id,tenant_id,space_id,docker_id,name,image,purpose,status,runtime_node_id,created_at,updated_at) VALUES('second','tenant','space','second-id','other','custom:image','workspace','running','node','before','before')`)
			case "retired-space":
				execTest(t, s, `UPDATE spaces SET workspace_generation=2`)
			case "invalid-path":
				space = "../space"
			}
			if _, err := s.AdoptLegacy(context.Background(), tenant, space, "disk", "instance", time.Now()); err == nil {
				t.Fatal("unsafe adoption accepted")
			}
			var n int
			if err := s.DB.QueryRow(`SELECT COUNT(*) FROM workspace_disks`).Scan(&n); err != nil || n != 0 {
				t.Fatalf("failed adoption left a disk: %d %v", n, err)
			}
		})
	}
}

func TestPinnedTargetNeverFollowsCurrentInstance(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i, err := s.AdoptLegacy(ctx, "tenant", "space", "disk", "instance", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	execTest(t, s, `UPDATE workspace_instances SET state='running' WHERE id='instance'`)
	execTest(t, s, `UPDATE workspace_disks SET state='attached',verified_at='now' WHERE id='disk'`)
	if _, _, err := s.Resolve(ctx, i.Target); err != nil {
		t.Fatal(err)
	}
	foreign := i.Target
	foreign.TenantID = "other"
	if _, _, err := s.Resolve(ctx, foreign); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("foreign target resolved: %v", err)
	}
	execTest(t, s, `UPDATE workspace_instances SET state='revoked',revoked_at='now' WHERE id='instance'`)
	execTest(t, s, `UPDATE spaces SET current_workspace_instance_id='replacement',workspace_generation=2`)
	if _, _, err := s.Resolve(ctx, i.Target); !errors.Is(err, ErrTargetRevoked) {
		t.Fatalf("revoked target followed new binding: %v", err)
	}
}

func TestLocatorValidation(t *testing.T) {
	for _, p := range []string{"", "../workspace", "disks/a/../../etc", "/disks/a/workspace", `disks\a\workspace`, "disks/a/workspace/", "disks/../workspace", "disks/a/workspace/child"} {
		if err := (Locator{Kind: "directory", RelativePath: p}).Validate(); err == nil {
			t.Errorf("unsafe locator accepted: %q", p)
		}
	}
	for _, l := range []Locator{{Kind: "directory", RelativePath: "disks/disk/workspace"}, {Kind: "legacy-bind", RelativePath: "spaces/space/workspace"}} {
		if err := l.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}
