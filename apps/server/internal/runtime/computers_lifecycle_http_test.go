package runtime

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestComputerLifecycleHTTP(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Lifecycle"})
	if err != nil {
		t.Fatal(err)
	}
	// No live runner: approval must become uncertain, not retry implicitly.
	for _, entry := range []struct{ id, provider string }{{"server", "server"}, {"cloud", "e2b"}, {"legacy:" + space.ID, "server"}} {
		if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,'tenant',?,'Computer',?,'now','now')`, entry.id, space.ID, entry.provider).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	owner := httpx.Principal{TenantID: "tenant", Role: "owner", UserID: "user"}
	base := "/spaces/" + space.ID + "/computers/server/runtimes"
	for _, p := range []httpx.Principal{{TenantID: "tenant"}, {TenantID: "tenant", Role: "owner", AgentID: "agent"}, {TenantID: "tenant", Role: "owner", APIKey: true}, {TenantID: "tenant", Role: "owner", SpaceID: "other"}} {
		if w := call("POST", base, "", p); w.Code != 403 {
			t.Fatalf("scope: %d %s", w.Code, w.Body)
		}
	}
	var count int64
	d.Gorm.Table("computer_runtimes").Count(&count)
	if count != 0 {
		t.Fatal("denied request reserved a runtime")
	}
	for _, id := range []string{"cloud", "legacy:" + space.ID, "missing"} {
		want := 501
		if id == "missing" {
			want = 404
		}
		if w := call("POST", "/spaces/"+space.ID+"/computers/"+id+"/runtimes", "", owner); w.Code != want {
			t.Fatalf("unsupported: %d %s", w.Code, w.Body)
		}
	}
	w := call("POST", base, "", owner)
	if w.Code != 200 {
		t.Fatalf("reserve: %d %s", w.Code, w.Body)
	}
	var reserved computerRuntimeResponse
	if err = json.Unmarshal(w.Body.Bytes(), &reserved); err != nil {
		t.Fatal(err)
	}
	if reserved.State != computers.PendingApproval || reserved.RuntimeID == "" || reserved.ExecutionAvailable {
		t.Fatalf("reservation: %+v", reserved)
	}
	if next := call("POST", base, "", owner); next.Body.String() != w.Body.String() {
		t.Fatal("reservation retry changed identity")
	}
	path := base + "/" + reserved.RuntimeID
	body := func(inc, op string, confirm bool) string {
		raw, _ := json.Marshal(map[string]any{"incarnation": inc, "createOperationId": op, "confirm": confirm})
		return string(raw)
	}
	valid := body(reserved.Incarnation, reserved.CreateOperationID, true)
	for _, payload := range []string{`{}`, body(reserved.Incarnation, reserved.CreateOperationID, false), valid + ` {}`, strings.TrimSuffix(valid, "}") + `,"nodeId":"other"}`} {
		if w := call("POST", path+"/approve", payload, owner); w.Code != 400 {
			t.Fatalf("invalid approval: %d %s", w.Code, w.Body)
		}
	}
	if w := call("POST", path+"/approve", body("stale", reserved.CreateOperationID, true), owner); w.Code != 404 {
		t.Fatalf("stale incarnation: %d", w.Code)
	}
	if w := call("POST", path+"/approve", body(reserved.Incarnation, "stale", true), owner); w.Code != 409 {
		t.Fatalf("stale operation: %d", w.Code)
	}
	if w := call("POST", path+"/reconcile", valid, owner); w.Code != 409 {
		t.Fatalf("unapproved reconciliation: %d", w.Code)
	}
	if w := call("POST", path+"/approve", valid, httpx.Principal{TenantID: "tenant", Role: "owner"}); w.Code != 403 {
		t.Fatalf("anonymous approval: %d", w.Code)
	}
	d.Gorm.Table("computer_creation_approvals").Count(&count)
	if count != 0 {
		t.Fatal("invalid approval persisted")
	}
	if w := call("GET", path, "", owner); w.Code != 400 {
		t.Fatalf("missing incarnation: %d", w.Code)
	}
	if w := call("GET", path+"?incarnation="+reserved.Incarnation, "", httpx.Principal{TenantID: "foreign", Role: "owner"}); w.Code == 200 {
		t.Fatal("cross tenant read")
	}
	if w := call("POST", path+"/approve", valid, owner); w.Code != 409 {
		t.Fatalf("offline approval: %d %s", w.Code, w.Body)
	}
	if w := call("POST", path+"/approve", valid, owner); w.Code != 409 {
		t.Fatalf("repeated approval: %d %s", w.Code, w.Body)
	}
	d.Gorm.Table("computer_creation_approvals").Count(&count)
	if count != 1 {
		t.Fatalf("approval count %d", count)
	}
	w = call("GET", path+"?incarnation="+reserved.Incarnation, "", owner)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"unknown"`) || strings.Contains(w.Body.String(), "tenant") || strings.Contains(w.Body.String(), "externalId") {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
}
