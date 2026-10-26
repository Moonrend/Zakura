package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	goruntime "runtime"
	"testing"
	"time"
)

func TestRunnerLegacyLocalRealRPCAndRemoteDoesNotFallback(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "sentinel"), []byte("local-content"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id, kind, version string
		token             any
	}{{"legacy", "local", "embedded", nil}, {"remote", "computer", "embedded", nil}, {"untrusted", "local", "dev", nil}, {"token-local", "local", "embedded", "hash"}} {
		if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,agent_version,token_hash,created_at,updated_at) VALUES(?,'tenant',?,?,?,'online',?,?,?,'before','before')`, row.id, row.id, row.id, row.kind, root, row.version, row.token).Error; err != nil {
			t.Fatal(err)
		}
	}
	hub := newRunnerHub(d)
	s, err := hub.get("legacy")
	if err != nil {
		t.Fatal(err)
	}
	defer s.close(context.Canceled)
	if s.nodeID != "legacy" || s.local == nil {
		t.Fatal("legacy identity lost")
	}
	var read struct{ Content string }
	if err := s.call(context.Background(), "host.fs.read", map[string]any{"path": "sentinel"}, &read); err != nil || read.Content != "local-content" {
		t.Fatalf("read: %s %v", read.Content, err)
	}
	command := []string{"/bin/sh", "-c", "printf local-exec"}
	if goruntime.GOOS == "windows" {
		command = []string{"cmd.exe", "/c", "echo local-exec"}
	}
	var execution struct{ Stdout string }
	if err := s.call(context.Background(), "host.exec", map[string]any{"command": command}, &execution); err != nil {
		t.Fatal(err)
	}
	if execution.Stdout == "" {
		t.Fatal("host exec returned no output")
	}
	var listed json.RawMessage
	if err := s.call(context.Background(), "host.fs.list", map[string]any{"path": "."}, &listed); err != nil {
		t.Fatal(err)
	}
	if err := s.call(context.Background(), "sys.update", map[string]any{}, nil); err == nil {
		t.Fatal("embedded executor may replace server binary")
	}
	for _, id := range []string{"remote", "untrusted", "token-local"} {
		if _, err := hub.get(id); err == nil {
			t.Fatalf("%s became local", id)
		}
	}
	var storage string
	if err := d.Gorm.Raw(`SELECT storage_root FROM runtime_nodes WHERE id='legacy'`).Row().Scan(&storage); err != nil || storage != root {
		t.Fatalf("root changed: %s %v", storage, err)
	}
}

func TestRunnerReconnectOwnershipAndDurableHeartbeat(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,created_at,updated_at) VALUES('remote','tenant','remote','remote','computer','online','/tmp','before','before')`).Error; err != nil {
		t.Fatal(err)
	}
	hub := newRunnerHub(d)
	makeSession := func() *runnerSession {
		return &runnerSession{hub: hub, nodeID: "remote", done: make(chan struct{}), pending: map[string]chan runnerReply{}}
	}
	old, current := makeSession(), makeSession()
	hub.install(old)
	hub.install(current)
	defer current.close(errors.New("test done"))
	hub.remove(old)
	var status, seen string
	if err := d.Gorm.Raw(`SELECT status FROM runtime_nodes WHERE id='remote'`).Row().Scan(&status); err != nil || status != "online" {
		t.Fatalf("old connection overwrote new: %s %v", status, err)
	}
	now := time.Now().UnixMilli()
	current.lastSeen.Store(now)
	if err := hub.persistHeartbeat(current); err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Raw(`SELECT last_seen_at FROM runtime_nodes WHERE id='remote'`).Row().Scan(&seen); err != nil || seen != runtimeTimeString(time.UnixMilli(now).UTC()) {
		t.Fatalf("heartbeat not durable: %s %v", seen, err)
	}
	if err := hub.persistHeartbeat(old); err == nil {
		t.Fatal("replaced connection wrote heartbeat")
	}
	hub.remove(current)
	if err := d.Gorm.Raw(`SELECT status FROM runtime_nodes WHERE id='remote'`).Row().Scan(&status); err != nil || status != "offline" {
		t.Fatalf("current disconnect not offline: %s %v", status, err)
	}
}
