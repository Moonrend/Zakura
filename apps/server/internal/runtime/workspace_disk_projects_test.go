package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceDiskProjectsFollowDiskAndFenceOldIntents(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	ctx := context.Background()
	space, err := NewStore(d).CreateSpace(ctx, "tenant", Space{Name: "Projects"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	directories := map[string]map[string]bool{}
	var inventoryError error
	h := builtinToolHarness(t, d, "rnr_projects", func(method string, params map[string]any) (any, error) {
		if method == "sys.info" {
			return map[string]any{"storageRoot": "/workspace-data", "capabilities": map[string]any{"docker": true}}, nil
		}
		var binding protocol.Binding
		raw, _ := json.Marshal(params["workspace"])
		if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil {
			return nil, errors.New("unbound project operation")
		}
		mu.Lock()
		defer mu.Unlock()
		dirs := directories[binding.Target.DiskID]
		if dirs == nil {
			dirs = map[string]bool{}
			directories[binding.Target.DiskID] = dirs
		}
		path, _ := params["path"].(string)
		switch method {
		case "host.fs.list":
			if inventoryError != nil {
				return nil, inventoryError
			}
			entries := []runnerFSEntry{}
			for slug := range dirs {
				entries = append(entries, runnerFSEntry{Name: slug, Path: "/projects/" + slug, IsDir: true})
			}
			return map[string]any{"entries": entries}, nil
		case "host.fs.mkdir":
			if slug, ok := strings.CutPrefix(path, "/projects/"); ok {
				dirs[slug] = true
			}
			return map[string]any{"ok": true}, nil
		case "host.fs.stat":
			slug := strings.TrimPrefix(path, "/projects/")
			if !dirs[slug] {
				return nil, errors.New("no such file")
			}
			return runnerFSEntry{Name: slug, Path: path, IsDir: true}, nil
		case "host.fs.rename":
			old := strings.TrimPrefix(params["oldPath"].(string), "/projects/")
			next := strings.TrimPrefix(params["newPath"].(string), "/projects/")
			if !dirs[old] {
				return nil, errors.New("no such file")
			}
			delete(dirs, old)
			dirs[next] = true
			return map[string]any{"ok": true}, nil
		case "host.fs.remove":
			delete(dirs, strings.TrimPrefix(path, "/projects/"))
			return map[string]any{"ok": true}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	old := attachTestWorkspace(t, h, space.ID, "project-old-disk", "project-old-instance")
	router := workspaceTestRouter(h, httpx.Principal{TenantID: "tenant"})
	base := "/spaces/" + space.ID + "/projects"
	code, result := workspaceTestRequest(t, router, "POST", base, `{"name":"demo","withWorkspace":true}`)
	if code != 200 || result["project"].(map[string]any)["hasWorkspace"] != true {
		t.Fatalf("create: %d %#v", code, result)
	}
	projectID := result["project"].(map[string]any)["id"].(string)
	assertPresence := func(want bool) {
		t.Helper()
		code, result := workspaceTestRequest(t, router, "GET", base, "")
		if code != 200 {
			t.Fatalf("list: %d %#v", code, result)
		}
		project := result["projects"].([]any)[0].(map[string]any)
		if project["hasWorkspace"] != want || !want && project["path"] != nil {
			t.Fatalf("incorrect disk presence: %#v", project)
		}
	}
	assertPresence(true)
	oldSpace, _ := h.store.GetSpace(ctx, "tenant", space.ID)
	oldCtx := context.WithValue(ctx, workspaceRequestTargetKey{}, oldSpace)
	oldIntent, err := h.reserveProjectIntent(oldCtx, "tenant", space.ID, projectIntent{ID: "old-rename", Kind: "update", Slug: "demo", Next: "renamed", HasWorkspace: true, WantWorkspace: true, Updates: map[string]any{"slug": "renamed"}})
	if err != nil {
		t.Fatal(err)
	}
	cleanup, err := h.workspaceStore().Retire(ctx, old.Target, "retire-project", "cleanup-project", false, h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	assertPresence(false) // No current workspace must not fall back to old files.
	current := attachTestWorkspace(t, h, space.ID, "project-new-disk", "project-new-instance")
	assertPresence(false)
	code, result = workspaceTestRequest(t, router, "PATCH", base+"/demo", `{"withWorkspace":true}`)
	if code != 200 || result["project"].(map[string]any)["hasWorkspace"] != true {
		t.Fatalf("new disk blocked by old intent: %d %#v", code, result)
	}
	assertPresence(true)
	if err := h.applyProjectIntentFS(ctx, "tenant", space.ID, oldIntent); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late rename: %v", err)
	}
	if err := h.finishProjectIntent(ctx, "tenant", space.ID, oldIntent); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late commit: %v", err)
	}
	if _, err := h.reserveProjectIntent(oldCtx, "tenant", space.ID, projectIntent{ID: "late-reservation", Kind: "delete", Slug: "late", Next: "late"}); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late reservation: %v", err)
	}
	if _, err := h.projectDiskPresence(oldCtx, "tenant", space.ID, []models.SpaceProject{{ID: &projectID, Slug: "demo"}}); !errors.Is(err, workspaces.ErrTargetRevoked) {
		t.Fatalf("late inventory: %v", err)
	}
	// Retained old-disk inventory is not rewritten by an empty replacement disk.
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM workspace_disk_projects WHERE project_id=?`, projectID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("disk projection: %d %v", count, err)
	}
	mu.Lock()
	inventoryError = errors.New("node offline")
	mu.Unlock()
	code, _ = workspaceTestRequest(t, router, "GET", base, "")
	if code == 200 {
		t.Fatal("offline inventory declared files absent")
	}
	mu.Lock()
	inventoryError = errors.New("workspace root does not exist")
	mu.Unlock()
	code, _ = workspaceTestRequest(t, router, "GET", base, "")
	if code == 200 {
		t.Fatal("missing disk declared files absent")
	}
	mu.Lock()
	inventoryError = nil
	mu.Unlock()
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM workspace_disk_projects WHERE project_id=?`, projectID).Scan(&count); err != nil || count != 2 {
		t.Fatal("failed inventory erased disk projection")
	}
	claimed, err := h.workspaceStore().ClaimCleanup(ctx, "tenant", space.ID, cleanup.ID, "cleanup-token", h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.workspaceStore().CompleteRelease(ctx, claimed, old.Target, h.store.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Retire(ctx, current.Target, "retire-new", "cleanup-new", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "configuring", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.workspaceStore().Attach(ctx, "tenant", space.ID, "project-reused-instance", old.DiskID, lease.Token, workspaces.Config{Kind: "container", Image: "test:image"}, h.store.now()); err != nil {
		t.Fatal(err)
	}
	lease.Space, err = h.store.GetSpace(ctx, "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.finish(ctx, "stopped", nil); err != nil {
		t.Fatal(err)
	}
	assertPresence(true)
	code, result = workspaceTestRequest(t, router, "PATCH", base+"/demo", `{"slug":"renamed"}`)
	if code != 200 {
		t.Fatalf("reused disk rename: %d %#v", code, result)
	}
	mu.Lock()
	if !directories[old.DiskID]["renamed"] || directories[old.DiskID]["demo"] || !directories[current.DiskID]["demo"] {
		t.Fatal("rename touched another disk")
	}
	mu.Unlock()
	code, result = workspaceTestRequest(t, router, "DELETE", base+"/renamed", "")
	if code != 200 {
		t.Fatalf("delete project: %d %#v", code, result)
	}
	mu.Lock()
	defer mu.Unlock()
	if directories[old.DiskID]["renamed"] || !directories[current.DiskID]["demo"] {
		t.Fatal("project deletion touched retained disk")
	}
}
