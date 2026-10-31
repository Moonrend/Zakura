package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func TestWorkspaceReconnectFencesRetiredInstanceBeforeReady(t *testing.T) {
	rig := newWorkspaceProxyRig(t)
	ctx := context.Background()
	old := attachProxyWorkspace(t, rig, "reconnect-old", "reconnect-instance-old")
	job, err := rig.h.workspaceStore().Retire(ctx, old.Target, "retire-reconnect", "cleanup-reconnect", false, rig.h.store.now())
	if err != nil {
		t.Fatal(err)
	}
	current := attachProxyWorkspace(t, rig, "reconnect-new", "reconnect-instance-new")
	if err := rig.h.deps.Gorm.Table("workspace_cleanup_tombstones").Where("id=?", job.ID).Update("next_attempt", time.Now().Add(time.Hour).UnixMilli()).Error; err != nil {
		t.Fatal(err)
	}
	original, err := rig.h.hub.get("node")
	if err != nil {
		t.Fatal(err)
	}
	original.close(context.Canceled)
	server := httptest.NewServer(http.HandlerFunc(rig.h.runnerHubHTTP))
	defer server.Close()
	requested := make(chan protocol.Target, 1)
	reply := make(chan struct{})
	defer func() {
		select {
		case <-reply:
		default:
			close(reply)
		}
	}()
	var effects atomic.Int32
	startMigrationRunner(t, server.URL, "rnr_workspace_proxy", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return codemodeInfo(), nil
		case "workspace.identity":
			return map[string]any{"version": 1, "incarnation": old.NodeIncarnation}, nil
		case "workspace.revoke":
			var binding protocol.Binding
			raw, _ := json.Marshal(params)
			if json.Unmarshal(raw, &binding) != nil || binding.Validate() != nil {
				return nil, context.Canceled
			}
			requested <- binding.Target
			<-reply
			return map[string]any{"target": binding.Target, "ok": true}, nil
		default:
			effects.Add(1)
			return nil, nil
		}
	})
	select {
	case target := <-requested:
		if target != old.Target {
			t.Fatalf("reconnect revoked replacement: %+v", target)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("reconnect skipped delayed cleanup revocation")
	}
	if _, err := rig.h.hub.get("node"); err == nil {
		t.Fatal("node became dispatchable before revocation acknowledgment")
	}
	close(reply)
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := rig.h.hub.get("node"); err == nil {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("node did not become ready after revocation")
		case <-ticker.C:
		}
	}
	if effects.Load() != 0 {
		t.Fatal("handshake started an execution effect")
	}
	saved, err := rig.h.workspaceStore().Current(ctx, "tenant", rig.space.ID)
	if err != nil || saved.Target != current.Target {
		t.Fatalf("reconnect changed current instance: %+v %v", saved, err)
	}
	disk, err := rig.h.workspaceStore().Disk(ctx, "tenant", old.DiskID)
	if err != nil || disk.State != "release_pending" || disk.AttachedInstanceID == nil {
		t.Fatalf("revocation falsely released disk: %+v %v", disk, err)
	}
}
