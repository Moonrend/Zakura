package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Token-registered nodes had no storage identity, so disks could never be
// created on them. Connecting a V2 node records its identity exactly once.
func TestRunnerHandshakeEnrollsWorkspaceIncarnation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	for _, node := range []string{"fresh", "known", "old"} {
		hash := sha256.Sum256([]byte("rnr_" + node))
		incarnation := ""
		if node == "known" {
			incarnation = "recorded-pool"
		}
		if err := d.Gorm.Table("runtime_nodes").Create(map[string]any{"id": node, "tenant_id": "tenant", "name": node, "slug": node, "kind": "computer", "status": "offline", "token_hash": hex.EncodeToString(hash[:]), "capabilities_json": "{}", "host_info_json": "{}", "storage_root": "/fixture", "labels_json": "{}", "is_shared": false, "incarnation": incarnation, "created_at": "before", "updated_at": "before"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	server := httptest.NewServer(http.HandlerFunc(h.runnerHubHTTP))
	defer server.Close()
	connect := func(node string, v2 bool) {
		startMigrationRunner(t, server.URL, "rnr_"+node, func(method string, _ map[string]any) (any, error) {
			switch method {
			case "sys.info":
				info := codemodeInfo()
				info["capabilities"] = map[string]any{"host": true, "workspaceProtocolV2": v2}
				return info, nil
			case "workspace.identity":
				return map[string]any{"version": 1, "incarnation": "pool-" + node}, nil
			}
			return nil, nil
		})
	}
	connect("fresh", true)
	connect("known", true)
	connect("old", false)
	incarnation := func(node string) string {
		var value string
		if err := d.DB.QueryRow(d.Rebind(`SELECT incarnation FROM runtime_nodes WHERE id=?`), node).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, fresh := h.hub.get("fresh")
		_, known := h.hub.get("known")
		_, old := h.hub.get("old")
		if fresh == nil && known == nil && old == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("nodes did not become ready: %v %v %v", fresh, known, old)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := incarnation("fresh"); got != "pool-fresh" {
		t.Fatalf("fresh node identity not enrolled: %q", got)
	}
	if got := incarnation("known"); got != "recorded-pool" {
		t.Fatalf("recorded identity replaced by a different pool: %q", got)
	}
	if got := incarnation("old"); got != "" {
		t.Fatalf("pre-V2 node enrolled: %q", got)
	}
}
