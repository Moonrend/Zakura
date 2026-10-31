package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestNodeEgressPolicyStoredSealedAndPushed(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	seedTenant(t, d, "borrower")
	hash := sha256.Sum256([]byte("rnr_egress"))
	if err := d.Gorm.Table("runtime_nodes").Create(map[string]any{"id": "egress-node", "tenant_id": "tenant", "name": "n", "slug": "n", "kind": "server", "status": "offline", "token_hash": hex.EncodeToString(hash[:]), "capabilities_json": "{}", "host_info_json": "{}", "storage_root": "/fixture", "labels_json": "{}", "is_shared": true, "created_at": "before", "updated_at": "before"}).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d), hub: newRunnerHub(d)}
	router := chi.NewRouter()
	h.registerNodeEgress(router)
	call := func(method, body string, p httpx.Principal) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/runtime-nodes/egress-node/egress", strings.NewReader(body))
		r = r.WithContext(httpx.WithPrincipal(r.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	owner := httpx.Principal{TenantID: "tenant", Role: "owner", UserID: "u1"}
	policy := `{"mode":"deny","allow":["**.github.com","pypi.org:443"," "],"deny":["10.0.0.0/8"],"upstream":"http://user:s3cret@proxy.corp:8080","logAllowed":true}`
	for _, p := range []httpx.Principal{
		{TenantID: "tenant", Role: "member"},
		{TenantID: "borrower", Role: "owner"},
		{TenantID: "tenant", Role: "owner", SpaceID: "s"},
	} {
		if w := call(http.MethodPut, policy, p); w.Code == http.StatusOK {
			t.Fatalf("unauthorized write accepted: %+v", p)
		}
	}
	if w := call(http.MethodPut, `{"mode":"deny","upstream":"ftp://x"}`, owner); w.Code != http.StatusBadRequest {
		t.Fatalf("bad upstream: %d", w.Code)
	}
	w := call(http.MethodPut, policy, owner)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "s3cret") || !strings.Contains(w.Body.String(), `"applied":false`) {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	var stored, mode string
	if err := d.DB.QueryRow(`SELECT upstream_enc,mode FROM node_egress_policies WHERE node_id='egress-node'`).Scan(&stored, &mode); err != nil || mode != "deny" || stored == "" || strings.Contains(stored, "s3cret") {
		t.Fatalf("upstream not sealed: %q %q %v", stored, mode, err)
	}
	w = call(http.MethodGet, "", owner)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "s3cret") || !strings.Contains(w.Body.String(), "proxy.corp:8080") || !strings.Contains(w.Body.String(), `"hasUpstream":true`) {
		t.Fatalf("get: %d %s", w.Code, w.Body)
	}
	// Editing rules without retyping credentials keeps the sealed upstream.
	if w := call(http.MethodPut, `{"mode":"deny","allow":["**.github.com"],"keepUpstream":true}`, owner); w.Code != http.StatusOK {
		t.Fatalf("keep upstream: %d %s", w.Code, w.Body)
	}
	kept, _, err := h.loadNodeEgress(t.Context(), "egress-node")
	if err != nil || kept.Upstream != "http://user:s3cret@proxy.corp:8080" || len(kept.Allow) != 1 {
		t.Fatalf("upstream lost: %+v %v", kept, err)
	}

	// Connecting the node pushes the stored policy before it serves work.
	server := httptest.NewServer(http.HandlerFunc(h.runnerHubHTTP))
	defer server.Close()
	applied := make(chan map[string]any, 1)
	startMigrationRunner(t, server.URL, "rnr_egress", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			info := codemodeInfo()
			info["kind"] = "server"
			info["capabilities"] = map[string]any{"host": true, "egressPolicy": true}
			return info, nil
		case "egress.apply":
			applied <- params
			return map[string]any{"ok": true}, nil
		}
		return nil, nil
	})
	select {
	case params := <-applied:
		raw, _ := json.Marshal(params)
		if params["mode"] != "deny" || params["upstream"] != "http://user:s3cret@proxy.corp:8080" || !strings.Contains(string(raw), "**.github.com") {
			t.Fatalf("pushed policy: %s", raw)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("policy not pushed on connect")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		var appliedAt *string
		_ = d.DB.QueryRow(`SELECT applied_at FROM node_egress_policies WHERE node_id='egress-node'`).Scan(&appliedAt)
		if appliedAt != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("apply outcome not recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
