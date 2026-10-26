// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"reflect"
	goruntime "runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/executor"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

// Only Docker lifecycle RPCs are simulated. sys.info and every host.fs RPC go
// through the public Agent facade; importing agent/internal/rpc here is illegal.
func TestWorkspaceMigrationPublicExecutorFilesystem(t *testing.T) {
	// sys.info probes Docker itself. A missing, absolute executable prevents it
	// from reaching an installed Docker client/daemon without faking capabilities.
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "no-docker"))
	for _, previousStatus := range []string{"running", "stopped"} {
		t.Run(previousStatus, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			d := testDeps(t)
			seedTenant(t, d, "tenant")
			roots := map[string]string{"source": t.TempDir(), "target": t.TempDir()}
			for node, root := range roots {
				if err := d.Gorm.Table("runtime_nodes").Create(map[string]any{
					"id": node, "tenant_id": "tenant", "name": node, "slug": node,
					"kind": "computer", "status": "online", "storage_root": root,
					"capabilities_json": "{}", "host_info_json": "{}", "labels_json": "{}",
					"is_shared": false, "created_at": "before", "updated_at": "before",
				}).Error; err != nil {
					t.Fatal(err)
				}
			}
			store := NewStore(d)
			source := "source"
			space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Executor migration", RuntimeNodeID: &source, WorkspaceKind: "container"})
			if err != nil {
				t.Fatal(err)
			}
			if err := d.Gorm.Table("spaces").Where("id=?", space.ID).Update("workspace_status", previousStatus).Error; err != nil {
				t.Fatal(err)
			}
			h := &handler{deps: d, store: store, hub: newRunnerHub(d), mcpSessions: map[string]spaceMCPSession{}}
			h.service = NewService(store)
			sourceRoot := filepath.Join(roots["source"], "spaces", space.ID, "workspace")
			targetRoot := filepath.Join(roots["target"], "spaces", space.ID, "workspace")
			files := map[string]string{
				".zakura/acp/codex/home/.migration-sentinel":           "synthetic HOME sentinel, not credentials\n",
				".zakura/acp/codex/home/.config/example/settings.json": "{\"theme\":\"migration\"}\n",
				".agents/skills/migration/SKILL.md":                    "# Migration fixture\nPreserve this skill.\n",
				".agents/skills/migration/run.sh":                      "#!/bin/sh\nprintf 'migration fixture\\n'\n",
				".zakura/components/fixture-mcp/state.bin":             "MCP state\x00\x01\xff\n",
				"projects/demo/nested/content.txt":                     "workspace content: 你好\nsecond line\n",
				"projects/demo/empty.txt":                              "",
			}
			for name, body := range files {
				filename := filepath.Join(sourceRoot, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(filename), 0750); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filename, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			script := filepath.Join(sourceRoot, ".agents", "skills", "migration", "run.sh")
			if goruntime.GOOS != "windows" {
				if err := os.Chmod(script, 0750); err != nil {
					t.Fatal(err)
				}
				if info, err := os.Stat(script); err != nil || info.Mode().Perm() != 0750 {
					t.Fatalf("executable fixture mode: %v, %v", info, err)
				}
			} else {
				t.Log("Windows has no POSIX executable mode; content migration remains exercised")
			}
			if err := os.MkdirAll(filepath.Join(sourceRoot, "projects", "demo", "empty-directory"), 0750); err != nil {
				t.Fatal(err)
			}
			for name, target := range map[string]string{
				".agents/skills/migration/run-link": "run.sh",
				".agents/skills/skill-link":         "migration",
			} {
				if err := os.Symlink(target, filepath.Join(sourceRoot, name)); err != nil {
					// Windows reports ERROR_PRIVILEGE_NOT_HELD (1314), which is
					// not classified as fs.ErrPermission by every Go release.
					if goruntime.GOOS != "windows" || (!errors.Is(err, fs.ErrPermission) && !errors.Is(err, syscall.Errno(1314))) {
						t.Fatal(err)
					}
					t.Logf("symlink %s unavailable without Windows symlink privilege: %v", name, err)
				}
			}
			before := migrationExecutorTree(t, sourceRoot)
			original, err := os.Stat(script)
			if err != nil {
				t.Fatal(err)
			}
			// Unrelated node data must neither be copied nor removed.
			for _, root := range roots {
				if err := os.WriteFile(filepath.Join(root, "keep-node-data"), []byte("not workspace data"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var mu sync.Mutex
			var effects []string
			states := map[string]string{"source": "exited", "target": ""}
			var targetContainer computerContainer
			if previousStatus == "running" {
				states["source"] = "running"
			}
			jobID := "executor-migration"
			for _, node := range []string{"source", "target"} {
				node := node
				startMigrationExecutorSession(t, h.hub, node, roots[node], func(request executor.Message) (any, error) {
					mu.Lock()
					defer mu.Unlock()
					var p struct {
						ID      string                                     `json:"id"`
						Remove  bool                                       `json:"remove"`
						Label   string                                     `json:"label"`
						Labels  map[string]string                          `json:"labels"`
						Volumes []struct{ HostPath, ContainerPath string } `json:"volumes"`
					}
					if err := json.Unmarshal(request.Params, &p); err != nil {
						return nil, err
					}
					switch request.Method {
					case "docker.list":
						if p.Label != "zakura.space="+space.ID {
							return nil, fmt.Errorf("unexpected Docker scope: %s", p.Label)
						}
						if states[node] == "" {
							return []any{}, nil
						}
						if node == "target" && targetContainer.DockerID != "" {
							return []computerContainer{targetContainer}, nil
						}
						return []map[string]any{{"dockerId": node + "-workspace", "name": node + "-workspace", "image": "fixture-image", "status": states[node], "labels": map[string]string{"zakura.tenant": "tenant", "zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
					case "docker.stop":
						if node != "source" || p.ID != "source-workspace" || p.Remove {
							return nil, fmt.Errorf("must retain the original workspace container: %s %s", node, request.Params)
						}
						states[node] = "exited"
					case "docker.images":
						return []computerImageStatus{}, nil
					case "docker.pull":
						if node != "target" {
							return nil, fmt.Errorf("unexpected source image pull")
						}
					case "docker.create":
						if node != "target" || states[node] != "" || p.Labels["zakura.space"] != space.ID || p.Labels["zakura.tenant"] != "tenant" || p.Labels["zakura.purpose"] != "workspace" || len(p.Volumes) != 1 || filepath.Clean(p.Volumes[0].HostPath) != filepath.Clean(targetRoot) || p.Volumes[0].ContainerPath != "/workspace" {
							return nil, fmt.Errorf("target must use the migrated canonical root: %s", request.Params)
						}
						current, err := store.GetSpace(ctx, "tenant", space.ID)
						if err != nil || current.RuntimeNodeID == nil || *current.RuntimeNodeID != "target" {
							return nil, fmt.Errorf("target started before canonical node switch: %v", err)
						}
						states[node] = "running"
						var params map[string]any
						if err := json.Unmarshal(request.Params, &params); err != nil {
							return nil, err
						}
						targetContainer = workspaceReceiptFixture(params, "target-workspace")
					case "docker.create.status":
						return workspaceReceiptStatusFixture(targetContainer), nil
					default:
						return nil, fmt.Errorf("unexpected Docker RPC: %s", request.Method)
					}
					effects = append(effects, node+":"+request.Method)
					return map[string]any{"ok": true, "dockerId": node + "-workspace"}, nil
				}, func(request, response executor.Message) error {
					if request.Method != "host.fs.migration" || response.OK == nil || !*response.OK {
						return nil
					}
					var p struct {
						Operation string `json:"operation"`
					}
					if err := json.Unmarshal(request.Params, &p); err != nil {
						return err
					}
					mu.Lock()
					defer mu.Unlock()
					effects = append(effects, node+":"+p.Operation)
					if node == "target" && (p.Operation == "import" || p.Operation == "verify") {
						if _, err := os.Lstat(targetRoot); !errors.Is(err, fs.ErrNotExist) {
							return fmt.Errorf("canonical files visible before commit: %v", err)
						}
						staged := filepath.Join(roots[node], "spaces", space.ID, ".workspace-migrations", jobID, "tree", ".zakura", "acp", "codex", "home", ".migration-sentinel")
						if body, err := os.ReadFile(staged); err != nil || string(body) != files[".zakura/acp/codex/home/.migration-sentinel"] {
							return fmt.Errorf("real staged HOME sentinel missing: %v", err)
						}
					}
					if node == "target" && p.Operation == "commit" {
						current, err := store.GetSpace(ctx, "tenant", space.ID)
						if err != nil || current.RuntimeNodeID == nil || *current.RuntimeNodeID != "source" {
							return fmt.Errorf("canonical node switched before filesystem commit: %v", err)
						}
					}
					return nil
				})
			}
			lease, err := h.acquireSpaceWorkspace(ctx, "tenant", space.ID, "migrating", false, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(lease.release)
			phase := "queued"
			job := models.WorkspaceMigration{ID: &jobID, TenantID: "tenant", SpaceID: space.ID, SourceNodeID: "source", TargetNodeID: "target", Status: "pending", Phase: &phase, ExcludePatternsJSON: "[]", CreatedAt: "before", UpdatedAt: "before"}
			if err := d.Gorm.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			h.runLeasedWorkspaceMigration(ctx, jobID, lease, "target")
			if err := d.Gorm.Where("id=?", jobID).Take(&job).Error; err != nil {
				t.Fatal(err)
			}
			if job.Status != "completed" || job.Phase == nil || *job.Phase != "completed" || !job.SourceRetained || job.ProgressPct != 100 {
				t.Fatalf("migration did not complete: status=%s phase=%v error=%v effects=%v", job.Status, migrationExecutorString(job.Phase), migrationExecutorString(job.Error), effects)
			}
			for _, root := range []string{sourceRoot, targetRoot} {
				if after := migrationExecutorTree(t, root); !reflect.DeepEqual(before, after) {
					t.Errorf("tree changed in %s\nwant: %#v\ngot: %#v", root, before, after)
				}
			}
			retained, err := os.Stat(script)
			if err != nil || !os.SameFile(original, retained) {
				t.Fatalf("original source file was replaced or removed: %v", err)
			}
			copied, err := os.Stat(filepath.Join(targetRoot, ".agents", "skills", "migration", "run.sh"))
			if err != nil || os.SameFile(original, copied) {
				t.Fatalf("target is not an independent file: %v", err)
			}
			current, err := store.GetSpace(ctx, "tenant", space.ID)
			if err != nil || current.RuntimeNodeID == nil || *current.RuntimeNodeID != "target" || current.WorkspaceStatus != previousStatus {
				t.Fatalf("canonical space: %+v, %v", current, err)
			}
			var serverNode string
			if err := d.Gorm.Table("computers").Select("runtime_node_id").Where("tenant_id=? AND space_id=? AND role='server'", "tenant", space.ID).Scan(&serverNode).Error; err != nil || serverNode != "target" {
				t.Fatalf("canonical server computer node=%q, err=%v", serverNode, err)
			}
			remote, selected, err := h.remoteSpaceWorkspace(ctx, "tenant", space.ID)
			if err != nil || !selected || remote == nil || remote.runner.nodeID != "target" {
				t.Fatalf("canonical workspace routing: selected=%v, err=%v", selected, err)
			}
			if _, err := remote.write(ctx, "/after-migration.txt", []byte("target only")); err != nil {
				t.Fatal(err)
			}
			if body, err := os.ReadFile(filepath.Join(targetRoot, "after-migration.txt")); err != nil || string(body) != "target only" {
				t.Fatalf("canonical write did not reach target: %q, %v", body, err)
			}
			if _, err := os.Lstat(filepath.Join(sourceRoot, "after-migration.txt")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("canonical write modified retained source: %v", err)
			}
			for _, root := range roots {
				if body, err := os.ReadFile(filepath.Join(root, "keep-node-data")); err != nil || string(body) != "not workspace data" {
					t.Fatalf("unrelated node data changed: %q, %v", body, err)
				}
			}
			var leases int64
			if err := d.Gorm.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=?", "tenant", space.ID).Count(&leases).Error; err != nil || leases != 0 {
				t.Fatalf("migration lease remains: %d, %v", leases, err)
			}
			mu.Lock()
			defer mu.Unlock()
			want := []string{"source:inspect", "target:prepare", "source:docker.stop", "source:export", "target:import", "target:verify", "target:commit"}
			wantTarget := ""
			if previousStatus == "running" {
				want = append(want, "target:docker.pull", "target:docker.create")
				wantTarget = "running"
			}
			if !reflect.DeepEqual(effects, want) || states["source"] != "exited" || states["target"] != wantTarget {
				t.Fatalf("lifecycle order/states: effects=%v want=%v states=%v", effects, want, states)
			}
		})
	}
}

func migrationExecutorString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

type migrationExecutorEntry struct {
	Mode os.FileMode
	Body string
	Link string
}

func migrationExecutorTree(t *testing.T, root string) map[string]migrationExecutorEntry {
	t.Helper()
	entries := map[string]migrationExecutorEntry{}
	if err := filepath.WalkDir(root, func(filename string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		name, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		value := migrationExecutorEntry{Mode: info.Mode()}
		switch {
		case info.Mode().IsRegular():
			body, err := os.ReadFile(filename)
			if err != nil {
				return err
			}
			value.Body = string(body)
		case info.Mode()&os.ModeSymlink != 0:
			value.Link, err = os.Readlink(filename)
			if err != nil {
				return err
			}
		}
		entries[filepath.ToSlash(name)] = value
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return entries
}

// A deterministic in-memory Hub transport avoids sockets, tokens and persistent
// node bindings while exercising the same wire messages as remote executors.
func startMigrationExecutorSession(t *testing.T, hub *runnerHub, node, root string, docker func(executor.Message) (any, error), observe func(executor.Message, executor.Message) error) {
	t.Helper()
	agent := executor.New("computer", root)
	server, client := net.Pipe()
	session := &runnerSession{hub: hub, nodeID: node, conn: server, rw: bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), writeGate: make(chan struct{}, 1), pending: map[string]chan runnerReply{}, streamQueues: map[string]*runnerStream{}, done: make(chan struct{})}
	session.ready.Store(true)
	session.lastSeen.Store(time.Now().UnixMilli())
	hub.install(session)
	readDone, dispatchDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(readDone); session.readLoop() }()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		session.close(errors.New("migration test finished"))
		_ = client.Close()
		<-dispatchDone
		<-readDone
		agent.Close()
	})
	go func() {
		defer close(dispatchDone)
		reader := bufio.NewReader(client)
		for {
			raw, err := readRunnerServerText(reader)
			if err != nil {
				return
			}
			var request executor.Message
			if json.Unmarshal([]byte(raw), &request) != nil || request.Type != "req" {
				continue
			}
			send := func(response executor.Message) {
				if err := observe(request, response); err != nil {
					ok := false
					response = executor.Message{Type: "res", ID: request.ID, OK: &ok, Error: err.Error()}
				}
				payload, err := json.Marshal(response)
				if err != nil {
					_ = client.Close()
					return
				}
				// Mask client frames, including the 64-bit length form for real archives.
				header := []byte{0x81}
				switch {
				case len(payload) < 126:
					header = append(header, 0x80|byte(len(payload)))
				case len(payload) <= 65535:
					header = binary.BigEndian.AppendUint16(append(header, 0x80|126), uint16(len(payload)))
				default:
					header = binary.BigEndian.AppendUint64(append(header, 0x80|127), uint64(len(payload)))
				}
				mask := []byte{1, 2, 3, 4}
				header = append(header, mask...)
				for i := range payload {
					payload[i] ^= mask[i%4]
				}
				if _, err := client.Write(append(header, payload...)); err != nil {
					_ = client.Close()
				}
			}
			if strings.HasPrefix(request.Method, "docker.") {
				result, err := docker(request)
				ok := err == nil
				encoded, _ := json.Marshal(result)
				response := executor.Message{Type: "res", ID: request.ID, OK: &ok, Result: encoded}
				if err != nil {
					response.Error = err.Error()
				}
				send(response)
			} else {
				agent.Dispatch(ctx, request, send)
			}
		}
	}()
}
