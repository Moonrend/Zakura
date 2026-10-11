package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	chat, err := h.store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	// No live runner: approval must become uncertain, not retry implicitly.
	for _, entry := range []struct{ id, provider string }{{"server", "server"}, {"cloud", "e2b"}, {"temporary", "temporary"}, {"railway", "railway"}, {"legacy:" + space.ID, "server"}} {
		if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,created_at,updated_at) VALUES(?,'tenant',?,'Computer',?,'now','now')`, entry.id, space.ID, entry.provider).Error; err != nil {
			t.Fatal(err)
		}
	}
	// The ssh computer carries the commands capability, so its DTO must report
	// execution as available. Credentials are sealed but never dialed: reservation
	// records intent only.
	_, sshKey, sshFingerprint := sshTestHostIdentity(t)
	sshSealed, err := computers.SealCredentials(d.Secret, "tenant", space.ID, "ssh", []byte(sshCredsJSON(t, sshKey, sshFingerprint, "127.0.0.1", "22")))
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,secret_ref,capabilities_json,created_at,updated_at) VALUES('ssh','tenant',?,'Computer','ssh',?,?,'now','now')`, space.ID, sshSealed, `["commands"]`).Error; err != nil {
		t.Fatal(err)
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
	for _, id := range []string{"legacy:" + space.ID, "missing"} {
		want := 501
		if id == "missing" {
			want = 404
		}
		if w := call("POST", "/spaces/"+space.ID+"/computers/"+id+"/runtimes", "", owner); w.Code != want {
			t.Fatalf("unsupported: %d %s", w.Code, w.Body)
		}
	}
	// Temporary computers are now provisioned through the same lifecycle; their
	// reservation is session-scoped and must recover the persisted operation.
	tw := call("POST", "/spaces/"+space.ID+"/computers/temporary/runtimes?session="+chat.ID, "", owner)
	if tw.Code != 200 {
		t.Fatalf("temporary reserve: %d %s", tw.Code, tw.Body)
	}
	var tempReserved computerRuntimeResponse
	if err = json.Unmarshal(tw.Body.Bytes(), &tempReserved); err != nil {
		t.Fatal(err)
	}
	if tempReserved.State != computers.PendingApproval || tempReserved.RuntimeID == "" {
		t.Fatalf("temporary reservation: %+v", tempReserved)
	}
	// E2B is session-scoped like temporary. Reservation records intent only and
	// never calls the provider, so it is safe to exercise without network access.
	e2bBase := "/spaces/" + space.ID + "/computers/cloud/runtimes"
	if w := call("POST", e2bBase, "", owner); w.Code != 400 {
		t.Fatalf("e2b reserve without session: %d %s", w.Code, w.Body)
	}
	ew := call("POST", e2bBase+"?session="+chat.ID, "", owner)
	if ew.Code != 200 {
		t.Fatalf("e2b reserve: %d %s", ew.Code, ew.Body)
	}
	var e2bReserved computerRuntimeResponse
	if err = json.Unmarshal(ew.Body.Bytes(), &e2bReserved); err != nil {
		t.Fatal(err)
	}
	if e2bReserved.State != computers.PendingApproval || e2bReserved.RuntimeID == "" || e2bReserved.ExecutionAvailable || e2bReserved.RuntimeID == tempReserved.RuntimeID {
		t.Fatalf("e2b reservation: %+v", e2bReserved)
	}
	if next := call("POST", e2bBase+"?session="+chat.ID, "", owner); next.Body.String() != ew.Body.String() {
		t.Fatal("e2b reservation retry changed identity")
	}
	// Railway is not session-scoped: reservation needs no session and, like every
	// other provider, records intent only, so it is safe to exercise offline. Its
	// approve/reconcile paths dial SSH and are covered by the provider unit tests.
	railwayBase := "/spaces/" + space.ID + "/computers/railway/runtimes"
	rw := call("POST", railwayBase, "", owner)
	if rw.Code != 200 {
		t.Fatalf("railway reserve: %d %s", rw.Code, rw.Body)
	}
	var railwayReserved computerRuntimeResponse
	if err = json.Unmarshal(rw.Body.Bytes(), &railwayReserved); err != nil {
		t.Fatal(err)
	}
	if railwayReserved.State != computers.PendingApproval || railwayReserved.RuntimeID == "" || railwayReserved.ExecutionAvailable {
		t.Fatalf("railway reservation: %+v", railwayReserved)
	}
	if next := call("POST", railwayBase, "", owner); next.Body.String() != rw.Body.String() {
		t.Fatal("railway reservation retry changed identity")
	}
	// SSH computers are not session-scoped either; reservation records intent only
	// and never dials. Execution stays unavailable until a runtime is ready, even
	// though the commands capability is already configured.
	sshBase := "/spaces/" + space.ID + "/computers/ssh/runtimes"
	sw := call("POST", sshBase, "", owner)
	if sw.Code != 200 {
		t.Fatalf("ssh reserve: %d %s", sw.Code, sw.Body)
	}
	var sshReserved computerRuntimeResponse
	if err = json.Unmarshal(sw.Body.Bytes(), &sshReserved); err != nil {
		t.Fatal(err)
	}
	if sshReserved.State != computers.PendingApproval || sshReserved.RuntimeID == "" || sshReserved.ExecutionAvailable {
		t.Fatalf("ssh reservation: %+v", sshReserved)
	}
	if next := call("POST", sshBase, "", owner); next.Body.String() != sw.Body.String() {
		t.Fatal("ssh reservation retry changed identity")
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

func TestComputerRuntimeExecutionAvailableRequiresReadyAndCommands(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Caps"})
	if err != nil {
		t.Fatal(err)
	}
	for id, caps := range map[string]string{"wired": `["commands"]`, "plain": `[]`, "wiredpending": `["commands"]`} {
		if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,capabilities_json,created_at,updated_at) VALUES(?,'tenant',?,'Computer','server',?,'now','now')`, id, space.ID, caps).Error; err != nil {
			t.Fatal(err)
		}
	}
	insert := func(id, computer, state string) {
		t.Helper()
		if err := d.Gorm.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,external_id,state,created_at,updated_at) VALUES(?,'tenant',?,?,'',?,?,'ctr',?,'now','now')`, id, space.ID, computer, "inc-"+id, "op-"+id, state).Error; err != nil {
			t.Fatal(err)
		}
	}
	insert("rt-ready-wired", "wired", "ready")
	insert("rt-ready-plain", "plain", "ready")
	insert("rt-pending-wired", "wiredpending", "pending_approval")
	router := chi.NewRouter()
	h.registerComputers(router)
	owner := httpx.Principal{TenantID: "tenant", Role: "owner", UserID: "user"}
	get := func(computer, rid string) computerRuntimeResponse {
		t.Helper()
		req := httptest.NewRequest("GET", "/spaces/"+space.ID+"/computers/"+computer+"/runtimes/"+rid+"?incarnation=inc-"+rid, nil)
		req = req.WithContext(httpx.WithPrincipal(req.Context(), owner))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("get %s: %d %s", rid, w.Code, w.Body)
		}
		var out computerRuntimeResponse
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if out := get("wired", "rt-ready-wired"); !out.ExecutionAvailable {
		t.Fatalf("ready commands computer: %+v", out)
	}
	if out := get("plain", "rt-ready-plain"); out.ExecutionAvailable {
		t.Fatalf("ready capability-less computer: %+v", out)
	}
	if out := get("wiredpending", "rt-pending-wired"); out.ExecutionAvailable {
		t.Fatalf("pending commands computer: %+v", out)
	}
}

func TestComputerReplaceHTTP(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := builtinToolHarness(t, d, "rnr_replace", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}, "hostInfo": map[string]any{}}, nil
		case "host.fs.mkdir":
			return map[string]any{"abs": fmt.Sprintf("/srv/zakura/%s", fmt.Sprint(params["path"]))}, nil
		case "docker.list":
			return []computerContainer{}, nil
		default:
			return nil, fmt.Errorf("unexpected RPC %s", method)
		}
	})
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Replace"})
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,capabilities_json,created_at,updated_at) VALUES('srv','tenant',?,'Srv','server','node','[]','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,created_at,updated_at) VALUES('remote','tenant',?,'Remote','remote_agent','node','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('rt','tenant',?,'srv','','inc','op','unknown','now','now')`, space.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = d.Gorm.Exec(`INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES('rt','op','admin',?)`, time.Now().UTC().Format(time.RFC3339Nano)).Error; err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	h.registerComputers(router)
	owner := httpx.Principal{TenantID: "tenant", Role: "owner", UserID: "user"}
	call := func(method, path, body string, p httpx.Principal) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	base := "/spaces/" + space.ID + "/computers/srv/runtimes/rt"
	body := func(inc, op string, confirm bool) string {
		raw, _ := json.Marshal(map[string]any{"incarnation": inc, "createOperationId": op, "confirm": confirm})
		return string(raw)
	}
	if w := call("POST", base+"/replace", body("inc", "op", false), owner); w.Code != 400 {
		t.Fatalf("missing confirm: %d %s", w.Code, w.Body)
	}
	if w := call("POST", base+"/replace", body("stale", "op", true), owner); w.Code != 404 {
		t.Fatalf("stale incarnation: %d %s", w.Code, w.Body)
	}
	if w := call("POST", base+"/replace", body("inc", "stale", true), owner); w.Code != 409 {
		t.Fatalf("stale operation: %d %s", w.Code, w.Body)
	}
	if w := call("POST", base+"/replace", body("inc", "op", true), httpx.Principal{TenantID: "tenant"}); w.Code != 403 {
		t.Fatalf("unprivileged replace: %d", w.Code)
	}
	w := call("POST", base+"/replace", body("inc", "op", true), owner)
	if w.Code != 200 {
		t.Fatalf("replace: %d %s", w.Code, w.Body)
	}
	var out computerRuntimeResponse
	if err = json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.State != computers.PendingApproval || out.RuntimeID == "rt" || out.ExecutionAvailable {
		t.Fatalf("replace result: %+v", out)
	}
	var prior string
	d.Gorm.Table("computer_runtimes").Where("id = ?", "rt").Pluck("state", &prior)
	if prior != "failed" {
		t.Fatalf("old runtime state: %q", prior)
	}
	if w := call("POST", "/spaces/"+space.ID+"/computers/remote/runtimes/rt/replace", body("inc", "op", true), owner); w.Code != 501 {
		t.Fatalf("non-server adapter: %d %s", w.Code, w.Body)
	}
}
