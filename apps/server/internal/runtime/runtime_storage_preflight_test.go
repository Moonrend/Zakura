package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestRunnerLocalInitializesLegacyStorageRoot(t *testing.T) {
	for _, relative := range []bool{false, true} {
		t.Run(fmt.Sprint(relative), func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			base := t.TempDir()
			root := filepath.Join(base, "data", "runner")
			stored := root
			if relative {
				t.Chdir(base)
				stored = filepath.Join("data", "runner")
			}
			if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,agent_version,created_at,updated_at) VALUES('local','tenant','Local','local','local','online',?,'embedded','before','before')`, stored).Error; err != nil {
				t.Fatal(err)
			}
			s, err := newRunnerHub(d).get("local")
			if err != nil {
				t.Fatal(err)
			}
			defer s.close(context.Canceled)
			var info struct{ StorageRoot string }
			if err := s.call(context.Background(), "sys.info", map[string]any{"light": false}, &info); err != nil || info.StorageRoot != root {
				t.Fatalf("executor root=%q want=%q err=%v", info.StorageRoot, root, err)
			}
			var created struct{ Abs string }
			if err := s.call(context.Background(), "host.fs.mkdir", map[string]any{"spaceId": "space", "path": "/"}, &created); err != nil {
				t.Fatal(err)
			}
			if created.Abs != filepath.Join(root, "spaces", "space", "workspace") {
				t.Fatalf("workspace=%q", created.Abs)
			}
			var persisted string
			if err := d.Gorm.Table("runtime_nodes").Select("storage_root").Where("id='local'").Scan(&persisted).Error; err != nil || persisted != root {
				t.Fatalf("persisted=%q want=%q err=%v", persisted, root, err)
			}
		})
	}
}

func TestRunnerLocalRejectsUnusableStorageRoot(t *testing.T) {
	for _, scenario := range []string{"empty", "file", "drive-relative", "parent-relative", "foreign-path"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			root := ""
			switch scenario {
			case "file":
				root = filepath.Join(t.TempDir(), "file")
				if err := os.WriteFile(root, []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "drive-relative":
				root = "C:storage"
			case "parent-relative":
				root = "../storage"
			case "foreign-path":
				root = `C:\storage`
				if filepath.Separator == '\\' {
					root = "/var/lib/zakura"
				}
			}
			if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,agent_version,created_at,updated_at) VALUES('local','tenant','Local','local','local','online',?,'embedded','before','before')`, root).Error; err != nil {
				t.Fatal(err)
			}
			if s, err := newRunnerHub(d).get("local"); err == nil {
				s.close(context.Canceled)
				t.Fatal("invalid storage root accepted")
			} else if !strings.Contains(err.Error(), "local runtime node storage root is unavailable:") {
				t.Fatalf("missing diagnostic: %v", err)
			}
			if scenario == "file" {
				if raw, err := os.ReadFile(root); err != nil || string(raw) != "preserve" {
					t.Fatalf("existing file changed: %q %v", raw, err)
				}
			}
		})
	}
}

func TestWorkspacePreflightFailureDoesNotRetainLease(t *testing.T) {
	for _, scenario := range []string{"start-list", "stop-list", "mkdir", "empty-path", "pull", "unsupported-receipts"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			node := "node"
			space, err := NewStore(d).CreateSpace(context.Background(), "tenant", Space{Name: scenario, RuntimeNodeID: &node, WorkspaceKind: "container", WorkspaceStatus: "stopped"})
			if err != nil {
				t.Fatal(err)
			}
			h := builtinToolHarness(t, d, "rnr_preflight_"+scenario, func(method string, params map[string]any) (any, error) {
				switch method {
				case "sys.info":
					return map[string]any{"kind": "server", "storageRoot": "/srv/zakura"}, nil
				case "docker.list":
					if strings.HasSuffix(scenario, "-list") {
						return nil, errors.New("fixture inspect failed")
					}
					return []computerContainer{}, nil
				case "host.fs.mkdir":
					if scenario == "mkdir" {
						return nil, errors.New("fixture mkdir failed")
					}
					if scenario == "empty-path" {
						return map[string]any{"abs": ""}, nil
					}
					return map[string]any{"abs": "/srv/zakura/workspace"}, nil
				case "docker.images":
					return []computerImageStatus{}, nil
				case "docker.pull":
					if scenario == "pull" {
						return nil, errors.New("fixture registry unavailable")
					}
					return map[string]any{}, nil
				default:
					return nil, fmt.Errorf("must not mutate container: %s", method)
				}
			})
			for attempt := 0; attempt < 2; attempt++ {
				if scenario == "stop-list" {
					err = h.stopSpaceWorkspace(context.Background(), space)
				} else {
					err = h.startSpaceWorkspace(context.Background(), space)
				}
				if err == nil || errors.Is(err, errWorkspaceStarting) {
					t.Fatalf("attempt %d did not return retryable preflight failure: %v", attempt, err)
				}
				failure := err.Error()
				var leases int64
				if err := d.Gorm.Table("computer_workspace_leases").Where("space_id=?", space.ID).Count(&leases).Error; err != nil || leases != 0 {
					t.Fatalf("preflight retained lease: %d %v", leases, err)
				}
				current, err := h.store.GetSpace(context.Background(), "tenant", space.ID)
				if err != nil || current.WorkspaceStatus != "stopped" {
					t.Fatalf("preflight changed status: %+v %v", current, err)
				}
				if current.LastError == nil || *current.LastError != failure {
					t.Fatalf("preflight diagnostic lost: got %v want %q", current.LastError, failure)
				}
			}
		})
	}
}

func TestWorkspaceMigrationRouteDoesNotAcquireConflictingWriteLease(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	for _, node := range []string{"source", "target"} {
		if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES(?,'tenant',?,?,'computer','offline','/srv/zakura','now','now')`, node, node, node).Error; err != nil {
			t.Fatal(err)
		}
	}
	source := "source"
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Migration route", RuntimeNodeID: &source})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerWorkspace(router)
	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/spaces/"+space.ID+"/migrations", strings.NewReader(`{"targetNodeId":"target"}`))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), httpx.Principal{TenantID: "tenant", Role: "owner"}))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "runtime node agent is offline") {
			t.Fatalf("migration rejected its own lease before reaching preflight: %d %s", response.Code, response.Body.String())
		}
		var leases int64
		if err := d.Gorm.Table("computer_workspace_leases").Where("space_id=?", space.ID).Count(&leases).Error; err != nil || leases != 0 {
			t.Fatalf("migration preflight retained lease: %d %v", leases, err)
		}
	}
	foreign := httptest.NewRequest(http.MethodPost, "/spaces/"+space.ID+"/migrations", strings.NewReader(`{"targetNodeId":"target"}`))
	foreign = foreign.WithContext(httpx.WithPrincipal(foreign.Context(), httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: "other"}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, foreign)
	if response.Code != http.StatusNotFound {
		t.Fatalf("migration lost Space authorization: %d %s", response.Code, response.Body.String())
	}
}
